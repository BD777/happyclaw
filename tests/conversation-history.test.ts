import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMessagesPage: vi.fn(),
  getConversationHistoryCutoff: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  getMessagesPage: mocks.getMessagesPage,
  getConversationHistoryCutoff: mocks.getConversationHistoryCutoff,
}));

const { buildRecentConversationHistoryContext } =
  await import('../src/conversation-history.js');

describe('conversation history recovery context', () => {
  beforeEach(() => {
    mocks.getMessagesPage.mockReset();
    mocks.getConversationHistoryCutoff.mockReset();
  });

  test('returns stable message IDs and tags every recovered turn', () => {
    mocks.getMessagesPage.mockReturnValue([
      {
        id: 'assistant-1',
        content: '收到',
        sender_name: 'HappyClaw',
        is_from_me: true,
      },
      {
        id: 'user-1',
        content: '原始任务',
        sender_name: 'Alice',
        is_from_me: false,
      },
    ]);

    const result = buildRecentConversationHistoryContext(
      'web:main#agent:agent-1',
      new Set(),
      { intro: '恢复上下文' },
    );

    expect(result?.messageIds).toEqual(['user-1', 'assistant-1']);
    expect(result?.context).toContain(
      '<history_message id="user-1" role="user" sender="Alice">原始任务</history_message>',
    );
    expect(result?.context).toContain(
      '<history_message id="assistant-1" role="assistant" sender="HappyClaw">收到</history_message>',
    );
  });

  test('excludes the pending turn from both context and known IDs', () => {
    mocks.getMessagesPage.mockReturnValue([
      {
        id: 'pending-1',
        content: '当前消息',
        sender_name: 'Alice',
        is_from_me: false,
      },
      {
        id: 'history-1',
        content: '历史消息',
        sender_name: 'Alice',
        is_from_me: false,
      },
    ]);

    const result = buildRecentConversationHistoryContext(
      'web:main',
      new Set(['pending-1']),
      { intro: '恢复上下文' },
    );

    expect(result?.messageIds).toEqual(['history-1']);
    expect(result?.context).not.toContain('id="pending-1"');
  });

  test('does not replay messages at or before a persisted isolation cutoff', () => {
    mocks.getConversationHistoryCutoff.mockReturnValue(
      '2026-08-19T01:00:00.000Z',
    );
    mocks.getMessagesPage.mockReturnValue([
      {
        id: 'safe-after-cutoff',
        content: '新的群聊消息',
        sender_name: 'Bob',
        is_from_me: false,
        timestamp: '2026-08-19T01:00:00.001Z',
      },
      {
        id: 'private-at-cutoff',
        content: '旧私聊秘密',
        sender_name: 'Alice',
        is_from_me: false,
        timestamp: '2026-08-19T01:00:00.000Z',
      },
      {
        id: 'private-before-cutoff',
        content: '更早的私聊秘密',
        sender_name: 'Alice',
        is_from_me: false,
        timestamp: '2026-08-19T00:59:59.999Z',
      },
    ]);

    const result = buildRecentConversationHistoryContext(
      'web:main',
      new Set(),
      { intro: '恢复上下文' },
    );

    expect(result?.messageIds).toEqual(['safe-after-cutoff']);
    expect(result?.context).toContain('新的群聊消息');
    expect(result?.context).not.toContain('旧私聊秘密');
  });
});
