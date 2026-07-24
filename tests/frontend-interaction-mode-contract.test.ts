import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';
import {
  DEFAULT_INTERACTION_MODE,
  normalizeInteractionMode,
  shouldShowStreamingPartialText,
} from '../web/src/lib/interaction-mode';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('frontend workspace interaction mode contract', () => {
  test('normalizes current, missing, and legacy values', () => {
    expect(DEFAULT_INTERACTION_MODE).toBe('assistant');
    expect(normalizeInteractionMode(undefined)).toBe('assistant');
    expect(normalizeInteractionMode(null)).toBe('assistant');
    expect(normalizeInteractionMode('legacy')).toBe('assistant');
    expect(normalizeInteractionMode('assistant')).toBe('assistant');
    expect(normalizeInteractionMode('proactive')).toBe('proactive');
    expect(normalizeInteractionMode('persona')).toBe('proactive');
  });

  test('sends the selected mode on create and PATCHes workspace changes', () => {
    const store = read('web/src/stores/chat.ts');
    const createDialog = read(
      'web/src/components/chat/CreateContainerDialog.tsx',
    );

    expect(store).toContain('body.interaction_mode = normalizeInteractionMode');
    expect(store).toContain('updateInteractionMode: async');
    expect(store).toContain('{ interaction_mode: interactionMode }');
    expect(createDialog).toContain("useState<InteractionMode>('assistant')");
    expect(createDialog).toContain(
      'options.interaction_mode = interactionMode',
    );
    expect(createDialog).toContain('Assistant 模式');
    expect(createDialog).toContain('主动模式');
  });

  test('exposes mode and safe runtime restart semantics in workspace settings', () => {
    const chatView = read('web/src/components/chat/ChatView.tsx');
    const settingsDialog = read(
      'web/src/components/chat/WorkspaceInteractionModeDialog.tsx',
    );
    const selector = read(
      'web/src/components/chat/InteractionModeSelector.tsx',
    );

    expect(chatView).toContain('<WorkspaceInteractionModeDialog');
    expect(chatView).toContain('工作区设置');
    expect(chatView).toContain("'主动' : 'Assistant'");
    expect(settingsDialog).toContain(
      '同一模式会应用到该工作区的 Web、飞书和所有已绑定渠道',
    );
    expect(settingsDialog).toContain('模式会作为系统级回复契约注入');
    expect(settingsDialog).toContain('Agent。切换后工作区运行时会安全重启');
    expect(settingsDialog).toContain('下一条新消息将按新模式继续');
    expect(selector).toContain('Assistant 模式（推荐）');
    expect(selector).toContain('主动模式');
    expect(selector).toContain('一轮可以发送多条');
    expect(selector).toContain('CircleCheck');
  });

  test('never presents uncommitted partial text in proactive mode', () => {
    expect(shouldShowStreamingPartialText('assistant')).toBe(true);
    expect(shouldShowStreamingPartialText('proactive')).toBe(false);

    const streamingDisplay = read(
      'web/src/components/chat/StreamingDisplay.tsx',
    );
    const messageList = read('web/src/components/chat/MessageList.tsx');

    expect(streamingDisplay).toContain(
      'showPartialText && streaming.partialText',
    );
    expect(streamingDisplay).toContain(
      "interactionMode === 'proactive' ? '正在处理…' : '正在准备...'",
    );
    expect(messageList).toContain('interactionMode={interactionMode}');
  });
});
