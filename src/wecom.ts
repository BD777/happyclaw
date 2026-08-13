// 企业微信「智能机器人」IM 通道（长连接）。
//
// 走企业微信官方 SDK `@wecom/aibot-node-sdk` 的 WebSocket 长连接：用 botId+secret
// 建连并鉴权，收 `message.text` 回调 → 归一化成 HappyClaw 消息 → 触发 agent；
// 回复走 SDK 的主动发送 `sendMessage(chatid, {msgtype:'markdown'})`（无需依赖回调帧）。
//
// 设计对齐现有 IM 通道（见 wechat.ts）：本模块只负责「连接 + 收发」，inbound 通过
// storeMessageDirect + notifyNewImMessage 交给通用的 GroupQueue→runAgent 流水线；
// outbound 由 im-manager 按 JID 前缀 `wecom:` 路由到本模块的 sendMessage。
import crypto from 'crypto';
import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import type { WsFrame, TextMessage } from '@wecom/aibot-node-sdk';
import { storeMessageDirect } from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';
import { logger } from './logger.js';
import { WeComStreamingController } from './wecom-streaming.js';

export interface WeComConnectionConfig {
  botId: string;
  secret: string;
  /** 企业 ID（企业微信「企业信息」底部）。当前收发不需要，仅作记录/未来 API 调用用。 */
  corpId?: string;
  /** 可选 HappyClaw 账号 id，仅用于日志。 */
  channelAccountId?: string;
}

export interface WeComConnectOpts {
  onReady?: () => void;
  onNewChat: (jid: string, name: string) => void;
  /** 将 IM chatJid 解析为绑定目标 JID（conversation agent 或工作区主对话）。 */
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null; sourceJid?: string } | null;
  /** 消息被路由到 conversation agent 后调用，触发 agent 处理。 */
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  /** 入库前对 provider JID 做规范化。 */
  normalizeIncomingJid?: (jid: string) => string;
  /** 群聊未 @ 机器人时的过滤：返回 false 则丢弃（企微智能机器人回调本身即被动触发，默认放行）。 */
  shouldProcessGroupMessage?: (chatJid: string, senderImId?: string) => boolean;
}

export interface WeComConnection {
  connect(opts: WeComConnectOpts): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void>;
  /**
   * Open a streaming reply session for `chatId`. Uses the latest stashed
   * inbound frame (req_id) for that chat to drive `replyStream`. Returns
   * undefined if no inbound frame is available yet (nothing to reply to).
   */
  createStreamingSession(
    chatId: string,
    onCardCreated?: (messageId: string) => void,
  ): Promise<WeComStreamingController | undefined>;
  isConnected(): boolean;
}

export function createWeComConnection(
  config: WeComConnectionConfig,
): WeComConnection {
  let ws: WSClient | null = null;
  let authenticated = false;
  let opts: WeComConnectOpts | null = null;
  const logCtx = { accountId: config.channelAccountId, botId: config.botId };
  // Latest inbound frame per WeCom chatId. replyStream() must echo the req_id
  // of the message it replies to, so we stash the most recent frame per chat.
  const inboundFrames = new Map<string, WsFrame<TextMessage>>();

  function resolveChatId(body: TextMessage): string {
    // 单聊：会话 id 用 from.userid；群聊：用 chatid。
    if (body.chattype === 'group' && body.chatid) return body.chatid;
    return body.from?.userid ?? body.chatid ?? '';
  }

  async function handleInbound(frame: WsFrame<TextMessage>): Promise<void> {
    try {
      const body = frame.body;
      if (!body) return;
      const content = body.text?.content?.trim();
      if (!content) return;
      const rawChatId = resolveChatId(body);
      if (!rawChatId) return;
      // Stash the frame so a streaming reply can reuse its req_id.
      inboundFrames.set(rawChatId, frame);
      const fromUserId = body.from?.userid ?? rawChatId;

      let jid = `wecom:${rawChatId}`;
      if (opts?.normalizeIncomingJid) jid = opts.normalizeIncomingJid(jid);

      const senderName = fromUserId; // 企微回调仅带 userid，无展示名
      opts?.onNewChat?.(jid, senderName);

      if (
        body.chattype === 'group' &&
        opts?.shouldProcessGroupMessage &&
        !opts.shouldProcessGroupMessage(jid, fromUserId)
      ) {
        return;
      }

      const routing = opts?.resolveEffectiveChatJid?.(jid) ?? null;
      const targetJid = routing?.effectiveJid ?? jid;

      const id = crypto.randomUUID();
      const timestamp = body.create_time
        ? new Date(body.create_time * 1000).toISOString()
        : new Date().toISOString();
      const senderId = `wecom:${fromUserId}`;

      storeMessageDirect(id, targetJid, senderId, senderName, content, timestamp, false, {
        sourceJid: jid,
      });
      broadcastNewMessage(
        targetJid,
        {
          id,
          chat_jid: targetJid,
          source_jid: jid,
          sender: senderId,
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        },
        routing?.agentId ?? undefined,
      );
      notifyNewImMessage();

      if (routing?.agentId) {
        opts?.onAgentMessage?.(jid, routing.agentId);
        logger.info(
          { ...logCtx, jid, effectiveJid: targetJid, agentId: routing.agentId },
          'WeCom message routed to agent',
        );
      } else {
        logger.info({ ...logCtx, jid, msgid: body.msgid }, 'WeCom message stored');
      }
    } catch (err) {
      logger.error({ ...logCtx, err }, 'WeCom inbound handling failed');
    }
  }

  return {
    async connect(connectOpts: WeComConnectOpts): Promise<void> {
      opts = connectOpts;
      const client = new WSClient({
        botId: config.botId,
        secret: config.secret,
        maxReconnectAttempts: -1, // 服务端常驻，无限重连
        logger: {
          debug: () => undefined,
          info: (msg: string) => logger.debug({ ...logCtx }, `WeCom SDK: ${msg}`),
          warn: (msg: string) => logger.warn({ ...logCtx }, `WeCom SDK: ${msg}`),
          error: (msg: string, err?: unknown) =>
            logger.error({ ...logCtx, err }, `WeCom SDK: ${msg}`),
        },
      });

      client.on('message.text', (data) => {
        void handleInbound(data);
      });
      client.on('authenticated', () => {
        authenticated = true;
        logger.info({ ...logCtx }, 'WeCom WebSocket authenticated');
        connectOpts.onReady?.();
      });
      client.on('connected', () => {
        logger.info({ ...logCtx }, 'WeCom WebSocket connected');
      });
      client.on('disconnected', (reason: string) => {
        authenticated = false;
        logger.warn({ ...logCtx, reason }, 'WeCom WebSocket disconnected');
      });
      client.on('reconnecting', (attempt: number) => {
        authenticated = false;
        logger.info({ ...logCtx, attempt }, 'WeCom WebSocket reconnecting');
      });
      client.on('error', (err: Error) => {
        logger.error({ ...logCtx, err }, 'WeCom WebSocket error');
      });

      client.connect();
      ws = client;
    },

    async disconnect(): Promise<void> {
      authenticated = false;
      try {
        ws?.disconnect();
      } finally {
        ws = null;
        opts = null;
        inboundFrames.clear();
      }
    },

    async sendMessage(chatId: string, text: string): Promise<void> {
      if (!ws) {
        logger.warn({ ...logCtx, chatId }, 'WeCom not connected, skip send');
        return;
      }
      const content = text?.trim();
      if (!content) return;
      await ws.sendMessage(chatId, {
        msgtype: 'markdown',
        markdown: { content },
      });
    },

    async createStreamingSession(
      chatId: string,
    ): Promise<WeComStreamingController | undefined> {
      if (!ws) {
        logger.warn({ ...logCtx, chatId }, 'WeCom not connected, no streaming session');
        return undefined;
      }
      const frame = inboundFrames.get(chatId);
      if (!frame) {
        // No inbound frame → no req_id to bind replyStream to. The caller
        // falls back to the plain sendMessage path.
        logger.debug(
          { ...logCtx, chatId },
          'WeCom streaming session skipped: no inbound frame yet',
        );
        return undefined;
      }
      const streamId = generateReqId('stream');
      const client = ws;
      return new WeComStreamingController({
        chatId,
        sendStream: async (streamContent: string, finish: boolean) => {
          // Always re-read the latest frame in case a newer inbound message
          // for the same chat arrived; fall back to the captured one.
          const f = inboundFrames.get(chatId) ?? frame;
          await client.replyStream(f, streamId, streamContent, finish);
        },
        fallbackSend: async (text: string) => {
          const body = text?.trim();
          if (!body) return;
          await client.sendMessage(chatId, {
            msgtype: 'markdown',
            markdown: { content: body },
          });
        },
      });
    },

    isConnected(): boolean {
      return authenticated && ws !== null;
    },
  };
}
