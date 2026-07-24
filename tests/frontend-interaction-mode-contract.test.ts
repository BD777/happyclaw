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
  test('defaults missing and legacy values to assistant mode', () => {
    expect(DEFAULT_INTERACTION_MODE).toBe('assistant');
    expect(normalizeInteractionMode(undefined)).toBe('assistant');
    expect(normalizeInteractionMode(null)).toBe('assistant');
    expect(normalizeInteractionMode('legacy')).toBe('assistant');
    expect(normalizeInteractionMode('assistant')).toBe('assistant');
    expect(normalizeInteractionMode('persona')).toBe('persona');
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
    expect(createDialog).toContain('助手模式');
    expect(createDialog).toContain('人物模式');
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
    expect(chatView).toContain(
      "interactionMode === 'persona' ? '人物' : '助手'",
    );
    expect(settingsDialog).toContain(
      '此设置会应用到该工作区的 Web、飞书和所有已绑定渠道。',
    );
    expect(settingsDialog).toContain(
      '运行时。尚未处理的消息和下一条新消息将按新模式继续。',
    );
    expect(selector).toContain('助手模式（推荐）');
    expect(selector).toContain('人物模式');
  });

  test('never presents uncommitted partial text in persona mode', () => {
    expect(shouldShowStreamingPartialText('assistant')).toBe(true);
    expect(shouldShowStreamingPartialText('persona')).toBe(false);

    const streamingDisplay = read(
      'web/src/components/chat/StreamingDisplay.tsx',
    );
    const messageList = read('web/src/components/chat/MessageList.tsx');

    expect(streamingDisplay).toContain(
      'showPartialText && streaming.partialText',
    );
    expect(streamingDisplay).toContain(
      "interactionMode === 'persona' ? '正在处理…' : '正在准备...'",
    );
    expect(messageList).toContain('interactionMode={interactionMode}');
  });
});
