#!/bin/bash
# NanoClaw Container Entrypoint
# Starts claude-code-router (if configured) and runs the agent runner
#
# Environment variables:
#   CLAUDE_CODE_ROUTER_URL - Set to "internal" to run router inside container
#
# Input: JSON via stdin (ContainerInput)
# Output: JSON to stdout (ContainerOutput)

set -e

cd /app

# Compile TypeScript
echo "[entrypoint] Compiling TypeScript..."
npx tsc --outDir /tmp/dist 2>&1 >&2

# Create symlink for node_modules
ln -s /app/node_modules /tmp/dist/node_modules

# Make dist read-only to prevent modifications
chmod -R a-w /tmp/dist

# Start claude-code-router in background if CLAUDE_CODE_ROUTER_URL is set to "internal"
CCR_PID=""
if [ "$CLAUDE_CODE_ROUTER_URL" = "internal" ]; then
  echo "[entrypoint] Starting claude-code-router inside container..."
  export CCR_NON_INTERACTIVE_MODE=true
  export CCR_HOST=127.0.0.1
  export CCR_PORT=3000

  # Start router in background
  ccr start &
  CCR_PID=$!

  # Wait for router to be ready (max 30 seconds)
  echo "[entrypoint] Waiting for claude-code-router to be ready..."
  for i in $(seq 1 30); do
    if curl -s http://127.0.0.1:3000/health > /dev/null 2>&1; then
      echo "[entrypoint] claude-code-router is ready (PID: $CCR_PID)"
      break
    fi
    if ! kill -0 $CCR_PID 2>/dev/null; then
      echo "[entrypoint] claude-code-router process died, exiting..."
      exit 1
    fi
    sleep 1
  done

  # Verify router is actually responding
  if ! curl -s http://127.0.0.1:3000/health > /dev/null 2>&1; then
    echo "[entrypoint] ERROR: claude-code-router failed to start within 30 seconds"
    exit 1
  fi
fi

# Cleanup function
cleanup() {
  local exit_code=$?

  # Stop router if it was started
  if [ -n "$CCR_PID" ]; then
    echo "[entrypoint] Stopping claude-code-router (PID: $CCR_PID)..."
    kill $CCR_PID 2>/dev/null || true
    wait $CCR_PID 2>/dev/null || true
  fi

  exit $exit_code
}

# Set trap for cleanup on exit
trap cleanup EXIT

# Read input from stdin and run the agent
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
