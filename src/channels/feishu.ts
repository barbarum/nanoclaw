/**
 * Feishu (Lark) Channel for NanoClaw
 * Supports both Feishu (China) and Lark (International) platforms
 *
 * Authentication: App ID + App Secret (tenant access token)
 * Messages: Text, rich text (post), images, files
 *
 * Uses WebSocket persistent connection for receiving events
 * https://open.feishu.cn/document/ukTMukTMukTM/ucDOzYjL3cDM14SM2gzN
 */

import WebSocket from 'ws';
import { Channel, NewMessage, RegisteredGroup } from '../types.js';
import { ChannelOpts, OnChatMetadata, OnInboundMessage } from './registry.js';
import { logger } from '../logger.js';
import { registerChannel } from './registry.js';
import { readEnvFile } from '../env.js';

interface FeishuConfig {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
  baseUrl: string;
  wsUrl?: string;
}

interface FeishuMessage {
  message_id: string;
  root_id: string;
  parent_id: string;
  create_time: string;
  chat_id: string;
  sender_id: {
    user_id: string;
    union_id: string;
    open_id: string;
  };
  message_type: 'text' | 'post' | 'image' | 'file' | 'audio' | 'media' | 'sticker';
  content: string;
}

interface FeishuChatInfo {
  chat_id: string;
  name: string;
  description?: string;
  owner_id?: string;
  chat_mode: 'group' | 'p2p';
  member_count?: number;
}

interface FeishuEventPayload {
  header: {
    event_type: string;
    event_id: string;
    create_time: string;
  };
  event: {
    message: FeishuMessage;
    sender?: {
      sender_id: {
        user_id: string;
        union_id: string;
        open_id: string;
      };
    };
  };
  token?: string; // Challenge token for URL verification
}

interface FeishuConnectResponse {
  code?: number;
  msg?: string;
  data?: {
    url: string;
    expire_time: string;
  };
}

export class FeishuChannel implements Channel {
  public readonly name = 'feishu';
  private config: FeishuConfig;
  private onMessage: OnInboundMessage;
  private onChatMetadata: OnChatMetadata;
  private getRegisteredGroups: () => Record<string, RegisteredGroup>;
  private connected = false;
  private tenantAccessToken?: string;
  private tokenExpiresAt = 0;
  private ws: WebSocket | null = null;
  private wsConnectTime = 0;
  private seenMessages = new Set<string>();
  private registeredChatIds = new Set<string>();
  private chatNames = new Map<string, string>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;

  constructor(opts: ChannelOpts, config?: FeishuConfig) {
    this.onMessage = opts.onMessage;
    this.onChatMetadata = opts.onChatMetadata;
    this.getRegisteredGroups = opts.registeredGroups;
    this.config = config || this.loadConfig();

    // Initialize registered chat IDs from existing registered groups
    this.updateRegisteredChatIds();
  }

  private updateRegisteredChatIds(): void {
    const groups = this.getRegisteredGroups();
    for (const jid of Object.keys(groups)) {
      if (this.ownsJid(jid)) {
        this.registeredChatIds.add(jid);
      }
    }
  }

  private loadConfig(): FeishuConfig {
    const env = readEnvFile([
      'FEISHU_APP_ID',
      'FEISHU_APP_SECRET',
      'FEISHU_VERIFICATION_TOKEN',
      'FEISHU_ENCRYPT_KEY',
      'FEISHU_PLATFORM',
    ]);

    const appId = env.FEISHU_APP_ID;
    const appSecret = env.FEISHU_APP_SECRET;
    const verificationToken = env.FEISHU_VERIFICATION_TOKEN;
    const encryptKey = env.FEISHU_ENCRYPT_KEY;
    const isFeishu = env.FEISHU_PLATFORM === 'feishu' || env.FEISHU_PLATFORM === 'china';

    if (!appId || !appSecret) {
      throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET must be set in .env');
    }

    return {
      appId,
      appSecret,
      verificationToken,
      encryptKey,
      baseUrl: isFeishu ? 'https://open.feishu.cn' : 'https://open.larksuite.com',
      wsUrl: isFeishu ? 'wss://ws.feishu.cn' : 'wss://ws.larksuite.com',
    };
  }

  async connect(): Promise<void> {
    logger.info({ platform: this.config.baseUrl }, 'Feishu channel connecting...');

    try {
      await this.refreshAccessToken();
      await this.connectWebSocket();
      this.connected = true;
      logger.info('Feishu channel connected via WebSocket');
    } catch (error) {
      logger.error({ error }, 'Feishu channel connection failed');
      throw error;
    }
  }

  private async refreshAccessToken(): Promise<void> {
    const now = Date.now();
    if (this.tenantAccessToken && now < this.tokenExpiresAt - 60000) {
      return; // Token still valid (with 1min buffer)
    }

    const response = await fetch(
      `${this.config.baseUrl}/open-apis/auth/v3/tenant_access_token/internal/`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      }
    );

    const data = await response.json() as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire_in?: number;
    };

    if (data.code !== 0 || !data.tenant_access_token) {
      throw new Error(`Failed to get Feishu access token: ${data.msg || 'Unknown error'}`);
    }

    this.tenantAccessToken = data.tenant_access_token;
    this.tokenExpiresAt = now + (data.expire_in || 7200) * 1000;
    logger.info({ expiresIn: data.expire_in }, 'Feishu access token refreshed');
  }

  private async connectWebSocket(): Promise<void> {
    if (!this.tenantAccessToken) {
      throw new Error('No access token available');
    }

    // Get WebSocket connection URL from Feishu API
    const connectResponse = await fetch(
      `${this.config.baseUrl}/open-apis/im/v1/ws/connect`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.tenantAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          connection_type: 'persistent_connection',
        }),
      }
    );

    const responseText = await connectResponse.text();
    logger.debug({ status: connectResponse.status, body: responseText.slice(0, 500) }, 'Feishu ws/connect response');

    let connectData: FeishuConnectResponse;
    try {
      connectData = JSON.parse(responseText);
    } catch (err) {
      throw new Error(`Invalid JSON from ws/connect: ${err instanceof Error ? err.message : String(err)}. Response: ${responseText.slice(0, 200)}`);
    }

    if (connectData.code !== 0 || !connectData.data?.url) {
      throw new Error(`Failed to get WebSocket URL: ${connectData.msg || 'Unknown error'}`);
    }

    const wsUrl = connectData.data.url;
    logger.info({ url: wsUrl }, 'Feishu WebSocket URL obtained');

    // Connect to WebSocket
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsUrl);

        this.ws.on('open', () => {
          logger.info('Feishu WebSocket connected');
          this.wsConnectTime = Date.now();
          this.reconnectAttempts = 0;
          resolve();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const payload = JSON.parse(data.toString()) as FeishuEventPayload;
            this.handleEvent(payload);
          } catch (err) {
            logger.warn({ err, raw: data.toString() }, 'Failed to parse Feishu WebSocket message');
          }
        });

        this.ws.on('error', (err) => {
          logger.error({ err }, 'Feishu WebSocket error');
          if (this.wsConnectTime === 0) {
            reject(err);
          }
        });

        this.ws.on('close', (code, reason) => {
          logger.info({ code, reason: reason?.toString() }, 'Feishu WebSocket closed');
          this.connected = false;
          this.ws = null;

          // Attempt reconnection
          if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
            logger.info({ delay, attempt: this.reconnectAttempts }, 'Reconnecting to Feishu WebSocket...');
            setTimeout(() => this.reconnectWebSocket(), delay);
          } else {
            logger.error('Max WebSocket reconnection attempts reached');
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private async reconnectWebSocket(): Promise<void> {
    try {
      await this.refreshAccessToken();
      await this.connectWebSocket();
      this.connected = true;
      logger.info('Feishu WebSocket reconnected');
    } catch (error) {
      logger.error({ error }, 'Feishu WebSocket reconnection failed');
    }
  }

  private handleEvent(payload: FeishuEventPayload): void {
    const { header, event } = payload;

    logger.debug({ eventType: header.event_type, eventId: header.event_id }, 'Feishu event received');

    // Handle URL verification challenge (for initial setup)
    if (header.event_type === 'url_verification' && payload.token) {
      logger.info({ token: payload.token }, 'Feishu URL verification challenge');
      // In webhook mode, we'd return the token, but for WebSocket this shouldn't happen
      return;
    }

    // Handle message events
    if (header.event_type === 'im.message.receive_v1' && event.message) {
      const msg = event.message;

      // Skip if we've seen this message
      if (this.seenMessages.has(msg.message_id)) {
        logger.debug({ messageId: msg.message_id }, 'Feishu message already seen');
        return;
      }

      // Skip messages from self (bot's own messages)
      if (event.sender?.sender_id.open_id === this.config.appId) {
        logger.debug({ messageId: msg.message_id }, 'Feishu message from self, skipping');
        return;
      }

      // Check if message is from a registered chat
      if (!this.registeredChatIds.has(msg.chat_id)) {
        logger.debug({ chatId: msg.chat_id }, 'Feishu message from unregistered chat');
        return;
      }

      this.seenMessages.add(msg.message_id);
      logger.info({ messageId: msg.message_id, chatId: msg.chat_id }, 'Feishu new message received');

      this.handleMessage(msg);
    }
  }

  private async handleMessage(msg: FeishuMessage): Promise<void> {
    // Get chat info for metadata (cache the name)
    let chatName = this.chatNames.get(msg.chat_id);
    if (!chatName) {
      const chatInfo = await this.getChatInfo(msg.chat_id);
      if (chatInfo?.name) {
        chatName = chatInfo.name;
        this.chatNames.set(msg.chat_id, chatName);
      }
    }

    // Emit metadata (for chat name discovery)
    this.onChatMetadata(
      msg.chat_id,
      msg.create_time,
      chatName || 'Feishu Chat',
      'feishu',
      msg.chat_id.startsWith('oc_') || msg.chat_id.startsWith('ch_'),
    );

    // Parse message content based on type
    let content = msg.content;
    try {
      if (msg.message_type === 'text') {
        const textData = JSON.parse(content) as { text: string };
        content = textData.text;
      } else if (msg.message_type === 'post') {
        // Parse post content (rich text)
        const postData = JSON.parse(content) as {
          content: Array<Array<{ tag: string; text?: string }>>;
        };
        content = postData.content
          .flat()
          .map(item => item.text || '')
          .join(' ');
      } else if (msg.message_type === 'image') {
        content = `[Image: ${msg.message_id}]`;
      } else if (msg.message_type === 'file') {
        content = `[File: ${msg.message_id}]`;
      }
    } catch (e) {
      logger.debug({ err: e, type: msg.message_type }, 'Failed to parse Feishu message content');
    }

    // Create NewMessage for NanoClaw
    const newMessage: NewMessage = {
      id: msg.message_id,
      chat_jid: msg.chat_id,
      sender: msg.sender_id?.open_id || 'unknown',
      sender_name: 'Feishu User',
      content: content,
      timestamp: msg.create_time,
      is_from_me: false,
      is_bot_message: false,
    };

    this.onMessage(msg.chat_id, newMessage);
  }

  private async getChatInfo(chatId: string): Promise<FeishuChatInfo | null> {
    try {
      const response = await fetch(
        `${this.config.baseUrl}/open-apis/im/v1/chats/${chatId}`,
        {
          headers: {
            'Authorization': `Bearer ${this.tenantAccessToken}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) return null;

      const data = await response.json() as { code?: number; data?: FeishuChatInfo };
      return data.data || null;
    } catch {
      return null;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.tenantAccessToken) {
      throw new Error('Feishu channel not connected');
    }

    const response = await fetch(
      `${this.config.baseUrl}/open-apis/im/v1/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.tenantAccessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          receive_id_type: 'chat_id',
          receive_id: jid,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to send Feishu message: ${error}`);
    }

    logger.debug({ jid, textLength: text.length }, 'Feishu message sent');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // Feishu doesn't support typing indicators
    logger.debug({ jid, isTyping }, 'Feishu typing indicator (not supported)');
  }

  async syncGroups(_force: boolean): Promise<void> {
    // Fetch chat names for all registered chats
    for (const chatId of this.registeredChatIds) {
      const info = await this.getChatInfo(chatId);
      if (info?.name) {
        this.chatNames.set(chatId, info.name);
        logger.debug({ chatId, name: info.name }, 'Feishu chat name synced');
      }
    }
  }

  isConnected(): boolean {
    return this.connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  ownsJid(jid: string): boolean {
    // Feishu chat IDs start with 'oc_' (groups) or 'ch_' (p2p)
    return jid.startsWith('oc_') || jid.startsWith('ch_') || /^[a-f0-9]{32}$/.test(jid);
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.tenantAccessToken = undefined;
    logger.info('Feishu channel disconnected');
  }
}

// Auto-register the channel if credentials are configured
export function createFeishuChannel(opts: ChannelOpts): Channel | null {
  const env = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  logger.debug({ env }, 'Feishu channel loading - env check');

  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
    logger.warn({ hasId: !!env.FEISHU_APP_ID, hasSecret: !!env.FEISHU_APP_SECRET }, 'Feishu channel credentials missing');
    return null;
  }

  try {
    const channel = new FeishuChannel(opts);
    logger.info('Feishu channel created successfully');
    return channel;
  } catch (error) {
    logger.warn({ error }, 'Feishu channel not enabled (constructor error)');
    return null;
  }
}

// Self-register with the channel registry
registerChannel('feishu', createFeishuChannel);
