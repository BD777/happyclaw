// Enterprise WeCom intelligent-bot channel (WebSocket long connection).
//
// Security invariants:
// - pairing/admission and route resolution run before chat registration,
//   persistence, frame caching, broadcasts, or Agent notification;
// - every account supplies account-scoped authorization callbacks;
// - a streaming reply is bound to the exact durable inbound message id, so a
//   later message in the same chat cannot steal its req_id;
// - outbound promises resolve only after the SDK receives a successful ACK.
import crypto from 'node:crypto';
import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';
import type { WsFrame, TextMessage } from '@wecom/aibot-node-sdk';
import { storeMessageDirect } from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';
import { logger } from './logger.js';
import {
  evaluateChannelAdmission,
  resolveAdmittedChannelRoute,
} from './channel-admission.js';
import { createDedupCache } from './im-utils.js';
import { ProcessingLock } from './im-safety/processing-lock.js';
import {
  WECOM_MARKDOWN_MAX_BYTES,
  WeComStreamingController,
} from './wecom-streaming.js';

const AUTH_TIMEOUT_MS = 15_000;
const MESSAGE_DEDUP_TTL_MS = 30 * 60_000;
const MESSAGE_DEDUP_MAX = 1000;
const FRAME_TTL_MS = 30 * 60_000;
const FRAME_CACHE_MAX = 1000;
const REJECT_COOLDOWN_MS = 60_000;
const PAGE_HEADER_RESERVE_BYTES = 64;

export type WeComConnectionState =
  | { status: 'connecting' }
  | { status: 'connected' }
  | { status: 'reconnecting'; attempt: number }
  | { status: 'disconnected'; error?: string }
  | { status: 'error'; error: string };

export interface WeComConnectionConfig {
  botId: string;
  secret: string;
  corpId?: string;
  channelAccountId?: string;
  /** Test-only override; production uses a bounded 15-second authentication wait. */
  authTimeoutMs?: number;
}

export interface WeComConnectOpts {
  onReady?: () => void;
  onNewChat: (jid: string, name: string) => void;
  ignoreMessagesBefore?: number;
  isChatAuthorized?: (jid: string) => boolean;
  onPairAttempt?: (
    jid: string,
    chatName: string,
    code: string,
  ) => Promise<boolean>;
  onConnectionStateChange?: (state: WeComConnectionState) => void;
  onCommand?: (
    chatJid: string,
    command: string,
    senderImId?: string,
  ) => Promise<string | null>;
  resolveEffectiveChatJid?: (chatJid: string) => {
    effectiveJid: string;
    agentId: string | null;
    sourceJid?: string;
  } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  normalizeIncomingJid?: (jid: string) => string;
  shouldProcessGroupMessage?: (chatJid: string, senderImId?: string) => boolean;
  isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
  isSenderAllowedInGroup?: (chatJid: string, senderImId?: string) => boolean;
  resolveRegisteredGroup?: (
    jid: string,
  ) => { activation_mode?: string } | undefined;
}

export interface WeComConnection {
  connect(opts: WeComConnectOpts): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void>;
  createStreamingSession(
    chatId: string,
    inputMessageId?: string,
  ): Promise<WeComStreamingController | undefined>;
  isConnected(): boolean;
}

interface CachedInboundFrame {
  frame: WsFrame<TextMessage>;
  chatId: string;
  expiresAt: number;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Split without cutting a Unicode code point. Prefer a recent line/space boundary. */
export function splitWeComMarkdown(
  text: string,
  maxBytes = WECOM_MARKDOWN_MAX_BYTES,
): string[] {
  if (maxBytes <= 0) throw new Error('maxBytes must be positive');
  const value = text.trim();
  if (!value) return [];
  if (utf8Bytes(value) <= maxBytes) return [value];

  const chunks: string[] = [];
  let remaining = value;
  while (utf8Bytes(remaining) > maxBytes) {
    let bytes = 0;
    let end = 0;
    let preferredEnd = 0;
    for (const char of remaining) {
      const charBytes = utf8Bytes(char);
      if (bytes + charBytes > maxBytes) break;
      bytes += charBytes;
      end += char.length;
      if (/\s/u.test(char) && bytes >= maxBytes * 0.65) preferredEnd = end;
    }
    const splitAt = preferredEnd || end;
    if (splitAt <= 0) throw new Error('Unable to paginate WeCom message');
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function sdkChatId(chatId: string): string {
  if (chatId.startsWith('c2c:')) return chatId.slice('c2c:'.length);
  if (chatId.startsWith('group:')) return chatId.slice('group:'.length);
  return chatId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createWeComConnection(
  config: WeComConnectionConfig,
): WeComConnection {
  let ws: WSClient | null = null;
  let authenticated = false;
  let opts: WeComConnectOpts | null = null;
  let intentionalDisconnect = false;
  const logCtx = { accountId: config.channelAccountId, botId: config.botId };
  const dedup = createDedupCache({
    ttlMs: MESSAGE_DEDUP_TTL_MS,
    max: MESSAGE_DEDUP_MAX,
  });
  const processingLock = new ProcessingLock();
  const rejectTimestamps = new Map<string, number>();
  // Exact durable input id -> original callback frame. Map insertion order is
  // the LRU order; a session removes its entry and retains the frozen frame.
  const inboundFrames = new Map<string, CachedInboundFrame>();

  function emitState(state: WeComConnectionState): void {
    try {
      opts?.onConnectionStateChange?.(state);
    } catch (error) {
      logger.warn({ ...logCtx, error }, 'WeCom state listener failed');
    }
  }

  function pruneFrames(now = Date.now()): void {
    for (const [inputId, cached] of inboundFrames) {
      if (cached.expiresAt > now) break;
      inboundFrames.delete(inputId);
    }
    while (inboundFrames.size > FRAME_CACHE_MAX) {
      const oldest = inboundFrames.keys().next().value;
      if (oldest === undefined) break;
      inboundFrames.delete(oldest);
    }
  }

  function cacheFrame(
    inputMessageId: string,
    chatId: string,
    frame: WsFrame<TextMessage>,
  ): void {
    pruneFrames();
    inboundFrames.delete(inputMessageId);
    inboundFrames.set(inputMessageId, {
      frame,
      chatId,
      expiresAt: Date.now() + FRAME_TTL_MS,
    });
    pruneFrames();
  }

  async function sendReply(
    client: WSClient,
    frame: WsFrame<TextMessage>,
    text: string,
  ): Promise<void> {
    await client.replyStream(frame, generateReqId('reply'), text, true);
  }

  async function sendMarkdownPages(
    client: WSClient,
    chatId: string,
    text: string,
  ): Promise<void> {
    const pageLimit = WECOM_MARKDOWN_MAX_BYTES - PAGE_HEADER_RESERVE_BYTES;
    const pages = splitWeComMarkdown(text, pageLimit);
    for (let index = 0; index < pages.length; index += 1) {
      const header =
        pages.length > 1 ? `（${index + 1}/${pages.length}）\n` : '';
      const content = `${header}${pages[index]}`;
      if (utf8Bytes(content) > WECOM_MARKDOWN_MAX_BYTES) {
        throw new Error('WeCom pagination exceeded the provider byte limit');
      }
      // The SDK rejects on a timeout or non-zero errcode; awaiting each page
      // makes a resolved delivery promise a strict provider ACK.
      await client.sendMessage(sdkChatId(chatId), {
        msgtype: 'markdown',
        markdown: { content },
      });
    }
  }

  function rawConversationJid(body: TextMessage): {
    jid: string;
    providerChatId: string;
    isGroup: boolean;
  } | null {
    if (body.chattype === 'group') {
      if (!body.chatid) return null;
      return {
        jid: `wecom:group:${body.chatid}`,
        providerChatId: body.chatid,
        isGroup: true,
      };
    }
    const userId = body.from?.userid;
    if (!userId) return null;
    return {
      jid: `wecom:c2c:${userId}`,
      providerChatId: userId,
      isGroup: false,
    };
  }

  async function handleInbound(frame: WsFrame<TextMessage>): Promise<void> {
    const body = frame.body;
    if (!body) return;
    const content = body.text?.content?.trim();
    if (!content) return;
    const conversation = rawConversationJid(body);
    if (!conversation) return;
    const eventId = body.msgid || frame.headers?.req_id;
    if (!eventId) return;
    const dedupKey = `${conversation.providerChatId}\u0000${eventId}`;
    if (dedup.isDuplicate(dedupKey)) return;
    if (!processingLock.acquire(dedupKey)) return;
    dedup.markSeen(dedupKey);

    try {
      const createdAt = body.create_time ? body.create_time * 1000 : 0;
      if (
        opts?.ignoreMessagesBefore &&
        (!createdAt || createdAt < opts.ignoreMessagesBefore)
      ) {
        return;
      }

      let jid = conversation.jid;
      if (opts?.normalizeIncomingJid) jid = opts.normalizeIncomingJid(jid);
      const fromUserId = body.from?.userid;
      if (!fromUserId) return;
      const senderName = fromUserId;

      // WeCom accounts must never inherit evaluateChannelAdmission's legacy
      // open-channel behavior: absent account-scoped auth is a deny.
      const admission = await evaluateChannelAdmission({
        jid,
        chatName: senderName,
        text: content,
        isChatAuthorized: opts?.isChatAuthorized ?? (() => false),
        onPairAttempt: opts?.onPairAttempt,
      });
      if (admission.kind === 'paired') {
        if (ws)
          await sendReply(ws, frame, '配对成功！此聊天已连接到你的工作区。');
        return;
      }
      if (admission.kind === 'pair_rejected') {
        if (ws) {
          await sendReply(
            ws,
            frame,
            '配对码无效或已过期，请在 Web 设置页重新生成。',
          );
        }
        return;
      }
      if (admission.kind === 'deny') {
        const now = Date.now();
        const lastReject = rejectTimestamps.get(jid) ?? 0;
        if (ws && now - lastReject >= REJECT_COOLDOWN_MS) {
          rejectTimestamps.set(jid, now);
          await sendReply(
            ws,
            frame,
            '此聊天尚未配对。请在 Web 设置页生成配对码，然后发送 /pair <code>。',
          );
        }
        logger.debug({ ...logCtx, jid }, 'Unauthorized WeCom chat ignored');
        return;
      }

      const resolvedRoute = resolveAdmittedChannelRoute(
        jid,
        opts?.resolveEffectiveChatJid,
      );
      if (!resolvedRoute) {
        logger.warn(
          { ...logCtx, jid },
          'WeCom message dropped: binding resolver rejected route',
        );
        return;
      }
      const { targetJid, routing } = resolvedRoute;

      const slashMatch = content.match(/^\/(\S+)(?:\s+(.*))?$/u);
      if (slashMatch && opts?.onCommand) {
        const command = `${slashMatch[1]}${slashMatch[2] ? ` ${slashMatch[2]}` : ''}`;
        const reply = await opts.onCommand(jid, command, fromUserId);
        if (reply && ws) await sendReply(ws, frame, reply);
        return;
      }

      if (
        conversation.isGroup &&
        opts?.isSenderAllowedInGroup &&
        !opts.isSenderAllowedInGroup(jid, fromUserId)
      ) {
        return;
      }
      if (
        conversation.isGroup &&
        opts?.shouldProcessGroupMessage &&
        !opts.shouldProcessGroupMessage(jid, fromUserId)
      ) {
        const mode = opts.resolveRegisteredGroup?.(jid)?.activation_mode;
        if (
          mode !== 'owner_mentioned' ||
          !opts.isGroupOwnerMessage?.(jid, fromUserId)
        ) {
          return;
        }
      }

      // All registration and business side effects are after admission,
      // routing, command handling, and group policy filters.
      opts?.onNewChat(jid, senderName);
      const id = crypto.randomUUID();
      const timestamp = new Date(createdAt || Date.now()).toISOString();
      const senderId = `wecom:${fromUserId}`;
      storeMessageDirect(
        id,
        targetJid,
        senderId,
        senderName,
        content,
        timestamp,
        false,
        { sourceJid: jid },
      );
      cacheFrame(id, conversation.providerChatId, frame);
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
      }
      logger.info(
        {
          ...logCtx,
          jid,
          effectiveJid: targetJid,
          agentId: routing?.agentId,
          msgid: body.msgid,
        },
        'WeCom message admitted and stored',
      );
    } catch (error) {
      logger.error({ ...logCtx, error }, 'WeCom inbound handling failed');
    } finally {
      processingLock.release(dedupKey);
    }
  }

  return {
    async connect(connectOpts: WeComConnectOpts): Promise<void> {
      if (ws) throw new Error('WeCom connection is already started');
      opts = connectOpts;
      intentionalDisconnect = false;
      authenticated = false;
      emitState({ status: 'connecting' });

      const client = new WSClient({
        botId: config.botId,
        secret: config.secret,
        maxReconnectAttempts: -1,
        logger: {
          debug: () => undefined,
          info: (message: string) =>
            logger.debug({ ...logCtx }, `WeCom SDK: ${message}`),
          warn: (message: string) =>
            logger.warn({ ...logCtx }, `WeCom SDK: ${message}`),
          error: (message: string, error?: unknown) =>
            logger.error({ ...logCtx, error }, `WeCom SDK: ${message}`),
        },
      });
      ws = client;

      let settleInitial: ((error?: Error) => void) | null = null;
      const authenticatedPromise = new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve();
        };
        settleInitial = finish;
      });
      const timeout = setTimeout(
        () => settleInitial?.(new Error('WeCom authentication timed out')),
        config.authTimeoutMs ?? AUTH_TIMEOUT_MS,
      );
      timeout.unref?.();

      client.on('message.text', (data) => {
        void handleInbound(data);
      });
      client.on('authenticated', () => {
        authenticated = true;
        emitState({ status: 'connected' });
        logger.info({ ...logCtx }, 'WeCom WebSocket authenticated');
        connectOpts.onReady?.();
        settleInitial?.();
      });
      client.on('connected', () => {
        logger.info({ ...logCtx }, 'WeCom WebSocket connected');
      });
      client.on('disconnected', (reason: string) => {
        authenticated = false;
        const error = reason || 'WebSocket disconnected';
        emitState({ status: 'disconnected', error });
        logger.warn({ ...logCtx, reason }, 'WeCom WebSocket disconnected');
        if (!intentionalDisconnect) settleInitial?.(new Error(error));
      });
      client.on('reconnecting', (attempt: number) => {
        authenticated = false;
        emitState({ status: 'reconnecting', attempt });
        logger.info({ ...logCtx, attempt }, 'WeCom WebSocket reconnecting');
      });
      client.on('error', (error: Error) => {
        authenticated = false;
        emitState({ status: 'error', error: error.message });
        logger.error({ ...logCtx, error }, 'WeCom WebSocket error');
        settleInitial?.(error);
      });

      try {
        client.connect();
        await authenticatedPromise;
      } catch (error) {
        authenticated = false;
        intentionalDisconnect = true;
        try {
          client.disconnect();
        } finally {
          if (ws === client) ws = null;
          opts = null;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        settleInitial = null;
      }
    },

    async disconnect(): Promise<void> {
      intentionalDisconnect = true;
      authenticated = false;
      const client = ws;
      ws = null;
      opts = null;
      inboundFrames.clear();
      rejectTimestamps.clear();
      dedup.clear();
      processingLock.dispose();
      client?.disconnect();
    },

    async sendMessage(chatId: string, text: string): Promise<void> {
      const client = ws;
      if (!client || !authenticated) {
        throw new Error('WeCom channel is not authenticated');
      }
      await sendMarkdownPages(client, chatId, text);
    },

    async createStreamingSession(
      chatId: string,
      inputMessageId?: string,
    ): Promise<WeComStreamingController | undefined> {
      const client = ws;
      if (!client || !authenticated) {
        throw new Error('WeCom channel is not authenticated');
      }
      pruneFrames();
      if (!inputMessageId) return undefined;
      const cached = inboundFrames.get(inputMessageId);
      if (!cached || cached.chatId !== sdkChatId(chatId)) return undefined;
      inboundFrames.delete(inputMessageId);
      const frame = cached.frame;
      const streamId = generateReqId('stream');
      return new WeComStreamingController({
        chatId,
        sendStream: async (streamContent: string, finish: boolean) => {
          // `frame` is deliberately closed over. Never re-read a per-chat map:
          // concurrent messages in one chat retain their own req_id.
          await client.replyStream(frame, streamId, streamContent, finish);
        },
        fallbackSend: async (fallbackText: string) => {
          await sendMarkdownPages(client, chatId, fallbackText);
        },
      });
    },

    isConnected(): boolean {
      return authenticated && ws !== null;
    },
  };
}
