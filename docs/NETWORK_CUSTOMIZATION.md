# Network Environment Customization

This guide explains how to configure NanoClaw for network environments with restricted access, such as users in China or other regions with limited connectivity to Anthropic's API.

## Contents

- [Chinese apt-get Mirrors](#chinese-apt-get-mirrors)
- [Claude Code Router Integration](#claude-code-router-integration)
- [Running Router in Docker](#running-router-in-docker)

---

## Chinese apt-get Mirrors

The Docker container uses Chinese mirrors (Aliyun) by default for faster `apt-get` package downloads from China. This is configured in `container/Dockerfile`:

```dockerfile
# Use Chinese mirrors for faster apt-get in China (Aliyun mirrors)
RUN sed -i 's|deb\.debian\.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources && \
    sed -i 's|security\.debian\.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources
```

### Using Different Mirrors

If you prefer different mirrors (e.g., Tencent, NetEase, or your own internal mirror), modify the `container/Dockerfile`:

```dockerfile
# Example: Use Tencent mirrors instead
RUN sed -i 's|deb\.debian\.org|mirrors.tencent.com|g' /etc/apt/sources.list.d/debian.sources && \
    sed -i 's|security\.debian\.org|mirrors.tencent.com|g' /etc/apt/sources.list.d/debian.sources
```

### Rebuilding the Container

After modifying the Dockerfile, rebuild the container:

```bash
# Prune the builder to ensure clean rebuild (cached layers may retain old files)
docker builder prune -f

# Rebuild the container image
./container/build.sh
```

---

## Claude Code Router Integration

[claude-code-router](https://github.com/musistudio/claude-code-router) is a proxy that routes Claude Code requests to different model providers. This is useful for:

- **Users in China**: Route through providers with better connectivity (DeepSeek, SiliconFlow, etc.)
- **Alternative models**: Use OpenRouter, Ollama, Gemini, Volcengine, etc.
- **Cost optimization**: Route different task types to different models

### Architecture

**Option A: Router Inside Container (Recommended)**

```
┌────────────────────────────────────────┐
│  NanoClaw Container                    │
│  ┌──────────────┐    ┌───────────────┐ │
│  │ Agent Runner │───▶│ CCR (local)   │ │
│  └──────────────┘    └───────┬───────┘ │
└──────────────────────────────┼─────────┘
                               │
                      ┌────────▼────────┐
                      │ Model Providers │
                      │ (DeepSeek, etc.)│
                      └─────────────────┘
```

**Option B: Router on Host**

```
┌─────────────────┐     ┌──────────────────────┐     ┌──────────────────┐
│  NanoClaw       │────▶│  claude-code-router  │────▶│  Model Providers │
│  Container      │     │  (runs on host)      │     │  (DeepSeek, etc.)│
└─────────────────┘     └──────────────────────┘     └──────────────────┘
```

---

### Option A: Router Inside Container (Recommended)

This mode runs claude-code-router **inside** each container. No host setup needed.

#### 1. Configure NanoClaw

Set `CLAUDE_CODE_ROUTER_URL` to `internal` in your `.env` file:

```env
# Run claude-code-router inside each container
CLAUDE_CODE_ROUTER_URL=internal
```

#### 2. Configure the Router

Create the configuration file at `~/.claude-code-router/config.json`:

```json
{
  "APIKEY": "",
  "PROXY_URL": "",
  "LOG": true,
  "Providers": [
    {
      "name": "deepseek",
      "api_base_url": "https://api.deepseek.com/chat/completions",
      "api_key": "YOUR_DEEPSEEK_API_KEY",
      "models": ["deepseek-chat", "deepseek-reasoner"],
      "transformer": {
        "use": ["deepseek"]
      }
    },
    {
      "name": "openrouter",
      "api_base_url": "https://openrouter.ai/api/v1/chat/completions",
      "api_key": "YOUR_OPENROUTER_API_KEY",
      "models": ["anthropic/claude-sonnet-4"],
      "transformer": {
        "use": ["openrouter"]
      }
    }
  ],
  "Router": {
    "default": "deepseek,deepseek-chat"
  }
}
```

See the [claude-code-router documentation](https://github.com/musistudio/claude-code-router) for all available providers and transformers.

#### 3. Restart NanoClaw

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux (systemd)
systemctl --user restart nanoclaw
```

The container will automatically start claude-code-router on first run.

---

### Option B: Router on Host

Run claude-code-router on the host and have containers connect to it.

#### 1. Install claude-code-router on the Host

```bash
# Install globally
npm install -g @musistudio/claude-code-router
```

#### 2. Configure claude-code-router

Create the configuration file at `~/.claude-code-router/config.json` (see example above).

#### 3. Start claude-code-router

```bash
# Start the router server (runs on port 3000 by default)
ccr start
```

Or run it in the background:

```bash
# As a background service
nohup ccr start > ~/.claude-code-router/router.log 2>&1 &
```

#### 4. Configure NanoClaw

Set `CLAUDE_CODE_ROUTER_URL` in your `.env` file:

```env
# Point containers to the router running on host
# host.docker.internal resolves to host machine from Docker containers
CLAUDE_CODE_ROUTER_URL=http://host.docker.internal:3000
```

#### 5. Restart NanoClaw

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux (systemd)
systemctl --user restart nanoclaw
```

---

## Running Router in Docker

Alternatively, you can run claude-code-router itself in a Docker container:

```bash
docker run -d \
  --name claude-code-router \
  -p 3000:3000 \
  -v ~/.claude-code-router:/root/.claude-code-router \
  -e HOST=0.0.0.0 \
  node:22-slim \
  sh -c "npm install -g @musistudio/claude-code-router && ccr start"
```

Then configure NanoClaw:

```env
# Containers connect to the router container via Docker network
CLAUDE_CODE_ROUTER_URL=http://host.docker.internal:3000
```

---

## How It Works

### Without Router (Default)

```
Container → Credential Proxy → api.anthropic.com
```

- Credential proxy injects Anthropic API key
- Direct connection to Anthropic (may be slow/blocked in China)

### With Router

```
Container → claude-code-router → Configured Provider
```

- Router transforms requests for the target provider
- Supports DeepSeek, OpenRouter, Ollama, Gemini, etc.
- Credential proxy is bypassed (router handles auth)

---

## Configuration Options

### Router Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_CODE_ROUTER_URL` | Router endpoint URL | (unset) |
| `CREDENTIAL_PROXY_PORT` | Local credential proxy port | `3001` |

### Router Configuration

Key `config.json` sections:

- **`PROXY_URL`**: HTTP proxy for API requests (e.g., `"http://127.0.0.1:7890"`)
- **`HOST`**: Router bind address (`"0.0.0.0"` to allow container connections)
- **`APIKEY`**: Optional authentication for router clients
- **`Providers`**: Model provider configurations
- **`Router`**: Routing rules (default model, background tasks, thinking, etc.)

---

## Troubleshooting

### Slow Container Builds

If container builds are still slow despite mirror configuration:

1. Check that the mirror URLs are accessible from your network
2. Try alternative mirrors (Tencent, NetEase, Tsinghua)
3. Verify the `sed` commands in Dockerfile are working:

   ```bash
   docker run --rm nanoclaw-agent:latest cat /etc/apt/sources.list.d/debian.sources
   ```

### Router Connection Issues

**For "internal" mode (router inside container):**

1. **Check container logs** for router startup:
   ```bash
   cat groups/<group-name>/logs/container-*.log | grep -i router
   ```

2. **Verify router starts** - look for these log lines:
   ```
   [entrypoint] Starting claude-code-router inside container...
   [entrypoint] claude-code-router is ready
   ```

3. **Check config file** exists at `~/.claude-code-router/config.json`

4. **Test router inside a container**:
   ```bash
   docker run --rm -e CLAUDE_CODE_ROUTER_URL=internal nanoclaw-agent:latest \
     sh -c "curl -v http://127.0.0.1:3000/health"
   ```

**For host mode (router on host):**

1. **Check router is running**:
   ```bash
   ccr status
   curl -v http://localhost:3000
   ```

2. **Check HOST binding**: Router must bind to `0.0.0.0` (not `127.0.0.1`) for container access:
   ```json
   {
     "HOST": "0.0.0.0"
   }
   ```

3. **Check firewall**: Ensure port 3000 is accessible from Docker

4. **Test from container**:
   ```bash
   docker run --rm nanoclaw-agent:latest curl -v http://host.docker.internal:3000
   ```

### Router Logs

Check router logs for incoming requests:

```bash
# Server logs
cat ~/.claude-code-router/logs/ccr-*.log

# Application logs
cat ~/.claude-code-router/claude-code-router.log
```

### Debug Logs in NanoClaw

Enable debug logging to see container connection details:

```env
LOG_LEVEL=debug
```

Check container logs for connection errors:

```bash
ls -lt groups/*/logs/
cat groups/<group-name>/logs/container-*.log
```
