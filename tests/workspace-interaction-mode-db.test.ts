import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'workspace-interaction-mode-db-'),
);
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Workspace AgentProfile interaction-mode binding', () => {
  test('defaults new bindings to assistant', () => {
    db.assignWorkspaceAgentProfile('assistant-workspace', 'profile-a');

    expect(db.getWorkspaceAgentProfileBinding('assistant-workspace')).toEqual(
      expect.objectContaining({
        group_folder: 'assistant-workspace',
        agent_profile_id: 'profile-a',
        interaction_mode: 'assistant',
      }),
    );
    expect(db.getWorkspaceInteractionMode('assistant-workspace')).toBe(
      'assistant',
    );
  });

  test('stores persona and preserves it when switching AgentProfile', () => {
    db.assignWorkspaceAgentProfile('persona-workspace', 'profile-a', 'persona');
    db.assignWorkspaceAgentProfile('persona-workspace', 'profile-b');

    expect(db.getWorkspaceAgentProfileBinding('persona-workspace')).toEqual(
      expect.objectContaining({
        agent_profile_id: 'profile-b',
        interaction_mode: 'persona',
      }),
    );
  });

  test('updates only existing bindings and leaves missing workspaces assistant', () => {
    db.assignWorkspaceAgentProfile('mutable-workspace', 'profile-a');

    expect(db.setWorkspaceInteractionMode('mutable-workspace', 'persona')).toBe(
      true,
    );
    expect(db.getWorkspaceInteractionMode('mutable-workspace')).toBe('persona');

    expect(db.setWorkspaceInteractionMode('missing-workspace', 'persona')).toBe(
      false,
    );
    expect(db.getWorkspaceInteractionMode('missing-workspace')).toBe(
      'assistant',
    );
  });
});
