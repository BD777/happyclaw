import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const discord = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: any[]) => unknown>>();
  const onceListeners = new Map<string, Array<(...args: any[]) => unknown>>();
  const client = {
    user: { id: 'bot-1', tag: 'test#0001' },
    application: { commands: { set: vi.fn(async () => []) } },
    guilds: { cache: { values: () => [] } },
    once(event: string, fn: (...args: any[]) => unknown) {
      const list = onceListeners.get(event) ?? [];
      list.push(fn);
      onceListeners.set(event, list);
    },
    on(event: string, fn: (...args: any[]) => unknown) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    },
    async login() {
      for (const fn of onceListeners.get('ready') ?? []) {
        await fn(client);
      }
    },
    async destroy() {},
    listeners,
  };
  return {
    client,
    listeners,
    ChannelType: { DM: 1, GuildText: 0, GroupDM: 3 },
    Events: {
      ClientReady: 'ready',
      InteractionCreate: 'interactionCreate',
      MessageCreate: 'messageCreate',
      GuildCreate: 'guildCreate',
      GuildDelete: 'guildDelete',
    },
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      DirectMessages: 4,
      MessageContent: 8,
      GuildMessageReactions: 16,
    },
    Partials: { Channel: 1, Message: 2 },
    AttachmentBuilder: class {},
  };
});

vi.mock('discord.js', () => ({
  Client: class {
    constructor() {
      return discord.client;
    }
  },
  GatewayIntentBits: discord.GatewayIntentBits,
  Events: discord.Events,
  Partials: discord.Partials,
  AttachmentBuilder: discord.AttachmentBuilder,
  ChannelType: discord.ChannelType,
}));

vi.mock('../src/db.js', () => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  updateChatName: vi.fn(),
}));
vi.mock('../src/message-notifier.js', () => ({
  notifyNewImMessage: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { storeMessageDirect } from '../src/db.js';
import { notifyNewImMessage } from '../src/message-notifier.js';
import {
  createDiscordConnection,
  discordSupplementalInboundText,
} from '../src/discord.js';

function fakeMsg(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? `m-${Math.random().toString(16).slice(2)}`,
    author: { bot: false, id: 'user-1', username: 'Ada', displayName: 'Ada' },
    member: { displayName: 'Ada' },
    channel: { type: discord.ChannelType.DM },
    channelId: 'chan-1',
    content: '',
    createdTimestamp: Date.now(),
    attachments: { values: () => [] },
    mentions: { has: () => false },
    react: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('discordSupplementalInboundText', () => {
  test('sticker-only uses sticker name', () => {
    expect(
      discordSupplementalInboundText({
        stickers: { values: () => [{ name: 'wave' }] },
      }),
    ).toBe('[表情包: wave]');
  });

  test('forward snapshot content is kept', () => {
    expect(
      discordSupplementalInboundText({
        messageSnapshots: {
          values: () => [{ message: { content: 'forwarded hello' } }],
        },
      }),
    ).toBe('forwarded hello');
  });
});

describe('Discord empty-gate live persist', () => {
  let connection: ReturnType<typeof createDiscordConnection> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    discord.listeners.clear();
  });

  afterEach(async () => {
    if (connection) {
      await connection.disconnect();
      connection = null;
    }
  });

  async function connect(authorized = true) {
    connection = createDiscordConnection({ botToken: 'test-token' });
    const ok = await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => authorized,
      resolveEffectiveChatJid: (jid: string) => ({
        effectiveJid: jid,
        agentId: null,
      }),
    });
    expect(ok).toBe(true);
    return connection;
  }

  test('sticker-only message persists and notifies', async () => {
    await connect();
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(
      fakeMsg({
        id: 'sticker-1',
        stickers: { values: () => [{ name: 'wave' }] },
      }),
    );
    expect(storeMessageDirect).toHaveBeenCalled();
    expect(storeMessageDirect.mock.calls[0][4]).toBe('[表情包: wave]');
    expect(notifyNewImMessage).toHaveBeenCalled();
  });

  test('forwarded snapshot with content persists', async () => {
    await connect();
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(
      fakeMsg({
        id: 'snap-1',
        messageSnapshots: {
          values: () => [{ message: { content: 'forwarded hello' } }],
        },
      }),
    );
    expect(storeMessageDirect).toHaveBeenCalled();
    expect(storeMessageDirect.mock.calls[0][4]).toBe('forwarded hello');
    expect(notifyNewImMessage).toHaveBeenCalled();
  });

  test('unauthorized sticker-only does not persist', async () => {
    await connect(false);
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(
      fakeMsg({
        id: 'sticker-deny',
        stickers: { values: () => [{ name: 'wave' }] },
      }),
    );
    expect(storeMessageDirect).not.toHaveBeenCalled();
    expect(notifyNewImMessage).not.toHaveBeenCalled();
  });

  test('empty message still does not persist', async () => {
    await connect();
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(fakeMsg({ id: 'empty-1' }));
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });
});
