import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  PERSONA_TAIL_INTERRUPTION_NOTICE,
  buildInteractionTextOutboxPayload,
  isInteractionTurnSettled,
  publishesFrameworkAnswer,
  resolveFrozenIpcInteractionMode,
  resolveRuntimeInteractionMode,
  shouldBroadcastSdkStreamEvent,
  shouldSendPersonaTailInterruptionNotice,
  usesNativeMessagePresentation,
} from '../src/workspace-interaction-runtime.js';

describe('workspace interaction runtime policy', () => {
  test('persona applies to public main and conversation loops only', () => {
    expect(
      resolveRuntimeInteractionMode('persona', { agentKind: 'main' }),
    ).toBe('persona');
    expect(
      resolveRuntimeInteractionMode('persona', {
        agentKind: 'conversation',
      }),
    ).toBe('persona');
    expect(
      resolveRuntimeInteractionMode('persona', { agentKind: 'spawn' }),
    ).toBe('assistant');
    expect(
      resolveRuntimeInteractionMode('persona', {
        agentKind: 'main',
        scheduledTask: true,
      }),
    ).toBe('assistant');
  });

  test('assistant publishes framework answers while persona uses native messages', () => {
    expect(publishesFrameworkAnswer('assistant')).toBe(true);
    expect(usesNativeMessagePresentation('assistant')).toBe(false);
    expect(publishesFrameworkAnswer('persona')).toBe(false);
    expect(usesNativeMessagePresentation('persona')).toBe(true);
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
      resolveFrozenIpcInteractionMode('persona', {
        scheduledTask: false,
        spawnAgent: false,
      }),
    ).toEqual({
      mode: 'persona',
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

  test('scheduled and spawn IPC can never opt into persona delivery', () => {
    expect(
      resolveFrozenIpcInteractionMode('persona', {
        scheduledTask: true,
        spawnAgent: false,
      }).mode,
    ).toBe('assistant');
    expect(
      resolveFrozenIpcInteractionMode('persona', {
        scheduledTask: false,
        spawnAgent: true,
      }).mode,
    ).toBe('assistant');
  });

  test('persona exposes lifecycle boundaries but no SDK internals to Web', () => {
    for (const statusText of ['requesting', 'idle', 'interrupted']) {
      expect(
        shouldBroadcastSdkStreamEvent('persona', {
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
      expect(shouldBroadcastSdkStreamEvent('persona', { eventType })).toBe(
        false,
      );
    }
    expect(
      shouldBroadcastSdkStreamEvent('persona', {
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

  test('persona permits healthy silence and treats a delivered utterance as irreversible', () => {
    expect(
      isInteractionTurnSettled({
        mode: 'persona',
        healthyInputTurnCompleted: true,
        utteranceDelivered: false,
      }),
    ).toBe(true);
    expect(
      isInteractionTurnSettled({
        mode: 'persona',
        healthyInputTurnCompleted: false,
        utteranceDelivered: true,
      }),
    ).toBe(true);
    expect(
      isInteractionTurnSettled({
        mode: 'persona',
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

  test('persona tail errors stop replay and require an incomplete-result notice', () => {
    expect(
      shouldSendPersonaTailInterruptionNotice({
        mode: 'persona',
        utteranceDelivered: true,
        runnerFailed: true,
      }),
    ).toBe(true);
    expect(PERSONA_TAIL_INTERRUPTION_NOTICE).toContain('可能不完整');
    expect(
      shouldSendPersonaTailInterruptionNotice({
        mode: 'persona',
        utteranceDelivered: false,
        runnerFailed: true,
      }),
    ).toBe(false);
    expect(
      shouldSendPersonaTailInterruptionNotice({
        mode: 'assistant',
        utteranceDelivered: true,
        runnerFailed: true,
      }),
    ).toBe(false);
  });

  test('wires persona tail notices to durable native delivery with a Web fallback', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/index.ts'),
      'utf8',
    );
    const helper = source.slice(
      source.indexOf('async function deliverPersonaTailInterruptionNotice'),
      source.indexOf('function resolveDurableChannelRoute'),
    );
    expect(helper).toContain('deliverIndependentChannelSystemNotice({');
    expect(helper).toContain("presentation: 'native'");
    expect(helper).toContain("sender: '__system__'");
    expect(helper).toContain('sendSystemMessage(');
    expect(source).toContain(
      'await notifyPersonaTailInterruption(ipcReplyTurnTracker.inputTurnId)',
    );
    expect(source).toContain(
      'await notifyPersonaAgentTailInterruption(activeAgentInputTurnId)',
    );
  });
});
