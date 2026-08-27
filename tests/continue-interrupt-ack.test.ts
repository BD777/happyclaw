import { describe, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const INDEX = path.resolve(__dirname, '../container/agent-runner/src/index.ts');

describe('internal continue interrupt emits host interrupted ACK', () => {
  const source = fs.readFileSync(INDEX, 'utf8');

  test('auto-continue and truncation-continue both ACK interrupted', () => {
    const autoAt = source.indexOf(
      'Auto-continue query was interrupted by user',
    );
    const truncAt = source.indexOf(
      'Truncation-continue query was interrupted by user',
    );
    expect(autoAt).toBeGreaterThan(-1);
    expect(truncAt).toBeGreaterThan(-1);

    const autoBlock = source.slice(autoAt, autoAt + 900);
    const truncBlock = source.slice(truncAt, truncAt + 900);
    expect(autoBlock).toContain("statusText: 'interrupted'");
    expect(truncBlock).toContain("statusText: 'interrupted'");
    expect(autoBlock).toContain('writeOutput');
    expect(truncBlock).toContain('writeOutput');
  });
});
