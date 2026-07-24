import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  PROACTIVE_TAIL_INTERRUPTION_NOTICE,
  buildInteractionTextOutboxPayload,
  isInteractionTurnSettled,
  publishesFrameworkAnswer,
  resolveFrozenIpcInteractionMode,
  resolveRuntimeInteractionMode,
  shouldBroadcastSdkStreamEvent,
  shouldSendProactiveTailInterruptionNotice,
  usesNativeMessagePresentation,
} from '../src/workspace-interaction-runtime.js';

describe('workspace interaction runtime policy', () => {
  test('proactive applies to public main and conversation loops only', () => {
    expect(
      resolveRuntimeInteractionMode('proactive', { agentKind: 'main' }),
    ).toBe('proactive');
    expect(
      resolveRuntimeInteractionMode('proactive', {
        agentKind: 'conversation',
      }),
    ).toBe('proactive');
    expect(
      resolveRuntimeInteractionMode('proactive', { agentKind: 'spawn' }),
    ).toBe('assistant');
    expect(
      resolveRuntimeInteractionMode('proactive', {
        agentKind: 'main',
        scheduledTask: true,
      }),
    ).toBe('assistant');
  });

  test('assistant publishes framework answers while proactive uses native messages', () => {
    expect(publishesFrameworkAnswer('assistant')).toBe(true);
    expect(usesNativeMessagePresentation('assistant')).toBe(false);
    expect(publishesFrameworkAnswer('proactive')).toBe(false);
    expect(usesNativeMessagePresentation('proactive')).toBe(true);
  });

  test('keeps the legacy assistant Outbox payload hash and extends only native sends', () => {
    expect(buildInteractionTextOutboxPayload('hello')).toEqual({
      text: 'hello',
    });
    expect(buildInteractionTextOutboxPayload('hello', 'default')).toEqual({
      text: 'hello',
    });
    expect(buildInteractionTextOutboxPayload('hello', 'native')).toEqual({
      text: 'hello',
      presentation: 'native',
    });
  });

  test('uses the IPC-file mode frozen before a workspace mode switch', () => {
    expect(
      resolveFrozenIpcInteractionMode('proactive', {
        scheduledTask: false,
        spawnAgent: false,
      }),
    ).toEqual({
      mode: 'proactive',
      valid: true,
      legacyDefaulted: false,
    });
    expect(
      resolveFrozenIpcInteractionMode('persona', {
        scheduledTask: false,
        spawnAgent: false,
      }),
    ).toEqual({
      mode: 'proactive',
      valid: true,
      legacyDefaulted: false,
    });
    expect(
      resolveFrozenIpcInteractionMode(undefined, {
        scheduledTask: false,
        spawnAgent: false,
      }),
    ).toEqual({
      mode: 'assistant',
      valid: true,
      legacyDefaulted: true,
    });
    expect(
      resolveFrozenIpcInteractionMode('malformed', {
        scheduledTask: false,
        spawnAgent: false,
      }),
    ).toMatchObject({ mode: 'assistant', valid: false });

    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const watcher = source.slice(
      source.indexOf('const frozenIpcMode ='),
      source.indexOf(
        'const authorized =',
        source.indexOf('const frozenIpcMode ='),
      ),
    );
    expect(watcher).toContain('data.interactionMode');
    expect(watcher).toContain('if (!frozenIpcMode.valid)');
    expect(watcher).not.toContain('getWorkspaceInteractionMode');
  });

  test('scheduled and spawn IPC can never opt into proactive delivery', () => {
    expect(
      resolveFrozenIpcInteractionMode('proactive', {
        scheduledTask: true,
        spawnAgent: false,
      }).mode,
    ).toBe('assistant');
    expect(
      resolveFrozenIpcInteractionMode('proactive', {
        scheduledTask: false,
        spawnAgent: true,
      }).mode,
    ).toBe('assistant');
    expect(
      resolveFrozenIpcInteractionMode('persona', {
        scheduledTask: false,
        spawnAgent: true,
      }).mode,
    ).toBe('assistant');
  });

  test('proactive exposes lifecycle boundaries but no SDK internals to Web', () => {
    for (const statusText of ['requesting', 'idle', 'interrupted']) {
      expect(
        shouldBroadcastSdkStreamEvent('proactive', {
          eventType: 'status',
          statusText,
        }),
      ).toBe(true);
    }
    for (const eventType of [
      'text_delta',
      'thinking_delta',
      'tool_use_start',
      'tool_result',
      'usage',
      'workflow',
      'task_start',
      'task_notification',
    ]) {
      expect(shouldBroadcastSdkStreamEvent('proactive', { eventType })).toBe(
        false,
      );
    }
    expect(
      shouldBroadcastSdkStreamEvent('proactive', {
        eventType: 'status',
        statusText: '正在深入分析…',
      }),
    ).toBe(false);
    expect(
      shouldBroadcastSdkStreamEvent('assistant', {
        eventType: 'tool_use_start',
      }),
    ).toBe(true);
  });

  test('proactive permits healthy silence and treats a delivered utterance as irreversible', () => {
    expect(
      isInteractionTurnSettled({
        mode: 'proactive',
        healthyInputTurnCompleted: true,
        utteranceDelivered: false,
      }),
    ).toBe(true);
    expect(
      isInteractionTurnSettled({
        mode: 'proactive',
        healthyInputTurnCompleted: false,
        utteranceDelivered: true,
      }),
    ).toBe(true);
    expect(
      isInteractionTurnSettled({
        mode: 'proactive',
        healthyInputTurnCompleted: false,
        utteranceDelivered: false,
      }),
    ).toBe(false);
  });

  test('assistant retains healthy-terminal plus physical-reply requirements', () => {
    expect(
      isInteractionTurnSettled({
        mode: 'assistant',
        healthyInputTurnCompleted: true,
        utteranceDelivered: true,
      }),
    ).toBe(true);
    expect(
      isInteractionTurnSettled({
        mode: 'assistant',
        healthyInputTurnCompleted: true,
        utteranceDelivered: false,
      }),
    ).toBe(false);
    expect(
      isInteractionTurnSettled({
        mode: 'assistant',
        healthyInputTurnCompleted: false,
        utteranceDelivered: true,
      }),
    ).toBe(false);
  });

  test('proactive tail errors stop replay and require an incomplete-result notice', () => {
    expect(
      shouldSendProactiveTailInterruptionNotice({
        mode: 'proactive',
        utteranceDelivered: true,
        runnerFailed: true,
      }),
    ).toBe(true);
    expect(PROACTIVE_TAIL_INTERRUPTION_NOTICE).toContain('可能不完整');
    expect(
      shouldSendProactiveTailInterruptionNotice({
        mode: 'proactive',
        utteranceDelivered: false,
        runnerFailed: true,
      }),
    ).toBe(false);
    expect(
      shouldSendProactiveTailInterruptionNotice({
        mode: 'assistant',
        utteranceDelivered: true,
        runnerFailed: true,
      }),
    ).toBe(false);
  });

  test('wires proactive tail notices to durable native delivery with a Web fallback', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const helper = source.slice(
      source.indexOf('async function deliverProactiveTailInterruptionNotice'),
      source.indexOf('function resolveDurableChannelRoute'),
    );
    expect(helper).toContain('deliverIndependentChannelSystemNotice({');
    expect(helper).toContain("presentation: 'native'");
    expect(helper).toContain("sender: '__system__'");
    expect(helper).toContain('sendSystemMessage(');
    expect(source).toContain(
      'await notifyProactiveTailInterruption(ipcReplyTurnTracker.inputTurnId)',
    );
    expect(source).toContain(
      'await notifyProactiveAgentTailInterruption(activeAgentInputTurnId)',
    );
  });
});
