import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8');

describe('Agent Runner reply-mode prompt contract', () => {
  test('injects one explicit contract into every public interactive Agent', () => {
    const runner = read('container/agent-runner/src/index.ts');
    const start = runner.indexOf('...(!containerInput.isScheduledTask');
    const end = runner.indexOf('});', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const selection = runner.slice(start, end);
    expect(selection).toContain('!containerInput.messageTaskId');
    expect(selection).toContain('proactiveInteractiveContract');
    expect(selection).toContain('PROACTIVE_DELIVERY_CONTRACT');
    expect(selection).toContain('ASSISTANT_DELIVERY_CONTRACT');
    expect(selection).not.toContain('containerInput.agentId');
    expect(runner).toContain("containerInput.interactionMode === 'proactive'");
  });

  test('aligns system guidance, tool behavior, and host projection semantics', () => {
    const assistant = read(
      'container/agent-runner/prompts/delivery-contract.assistant.md',
    );
    const proactive = read(
      'container/agent-runner/prompts/delivery-contract.proactive.md',
    );
    const tools = read('container/agent-runner/src/mcp-tools.ts');
    const runner = read('container/agent-runner/src/index.ts');
    const proactiveOutput = read(
      'container/agent-runner/prompts/output.proactive.md',
    );
    const hostPolicy = read('src/workspace-interaction-runtime.ts');

    expect(assistant).toContain('automatically publishes');
    expect(proactive).toContain(
      '`mcp__happyclaw__send_message` is the only way',
    );
    expect(tools).toContain(
      "ctx.interactionMode === 'proactive' && !ctx.isScheduledTask",
    );
    expect(tools).toContain("presentation: 'native'");
    expect(runner).toContain('!proactiveInteractiveContract &&');
    expect(runner).toContain(
      'result: proactiveInteractiveContract ? null : finalText',
    );
    expect(proactiveOutput).not.toContain('最终回复必须自包含');
    expect(proactiveOutput).toContain(
      '[Your previous response had no visible output.',
    );
    expect(hostPolicy).toContain("return mode === 'assistant';");
    expect(hostPolicy).toContain("return mode === 'proactive';");
  });
});
