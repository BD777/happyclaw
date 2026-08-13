import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-files-'));
const groupsDir = path.join(tmpRoot, 'groups');

vi.mock('../src/config.js', () => ({
  DATA_DIR: tmpRoot,
  GROUPS_DIR: groupsDir,
  MAX_FILE_SIZE: 50 * 1024 * 1024,
}));

vi.mock('../src/runtime-config.js', () => ({
  deleteContainerEnvConfig: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// Import AFTER the mocks so file-manager picks up the mocked GROUPS_DIR.
const {
  isSystemPath,
  isEditableSystemPath,
  isEditLockedPath,
  listFiles,
  deleteFile,
} = await import('../src/file-manager.ts');

const FOLDER = 'flow-x';
const folderRoot = path.join(groupsDir, FOLDER);

beforeEach(() => {
  fs.rmSync(folderRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(folderRoot, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(folderRoot, 'conversations'), { recursive: true });
  fs.writeFileSync(path.join(folderRoot, 'CLAUDE.md'), '# workspace rules\n');
  fs.writeFileSync(path.join(folderRoot, 'notes.md'), 'hello\n');
  fs.writeFileSync(path.join(folderRoot, 'logs', 'CLAUDE.md'), 'nested\n');
});

describe('system path protection', () => {
  test('CLAUDE.md stays a system path so delete/upload protection is unchanged', () => {
    expect(isSystemPath('CLAUDE.md')).toBe(true);
    expect(() => deleteFile(FOLDER, 'CLAUDE.md')).toThrow(
      'Cannot delete system path',
    );
    expect(fs.existsSync(path.join(folderRoot, 'CLAUDE.md'))).toBe(true);
  });

  test('workspace CLAUDE.md is the editable exception', () => {
    expect(isEditableSystemPath('CLAUDE.md')).toBe(true);
    expect(isEditLockedPath('CLAUDE.md')).toBe(false);
    expect(isEditLockedPath('./CLAUDE.md')).toBe(false);
  });

  test('the exception does not leak into nested system directories', () => {
    for (const nested of [
      path.join('logs', 'CLAUDE.md'),
      path.join('.claude', 'CLAUDE.md'),
      path.join('conversations', 'CLAUDE.md'),
    ]) {
      expect(isEditableSystemPath(nested)).toBe(false);
      expect(isEditLockedPath(nested)).toBe(true);
    }
  });

  test('other system paths remain edit-locked', () => {
    expect(isEditLockedPath('logs')).toBe(true);
    expect(isEditLockedPath(path.join('logs', 'agent.log'))).toBe(true);
    expect(isEditLockedPath(path.join('.claude', 'settings.json'))).toBe(true);
    expect(isEditLockedPath(path.join('conversations', '2026-08-11.md'))).toBe(
      true,
    );
  });

  test('non-system files are untouched', () => {
    expect(isEditableSystemPath('notes.md')).toBe(false);
    expect(isEditLockedPath('notes.md')).toBe(false);
  });
});

describe('listFiles editable flag', () => {
  test('marks workspace CLAUDE.md as system but editable', () => {
    const { files } = listFiles(FOLDER);
    const claudeMd = files.find((f) => f.name === 'CLAUDE.md');
    expect(claudeMd).toMatchObject({
      isSystem: true,
      editable: true,
      type: 'file',
    });
  });

  test('keeps system directories non-editable', () => {
    const { files } = listFiles(FOLDER);
    expect(files.find((f) => f.name === 'logs')).toMatchObject({
      isSystem: true,
      editable: false,
    });
    expect(files.find((f) => f.name === 'conversations')).toMatchObject({
      isSystem: true,
      editable: false,
    });
  });

  test('nested CLAUDE.md under logs is not editable', () => {
    const { files } = listFiles(FOLDER, 'logs');
    expect(files.find((f) => f.name === 'CLAUDE.md')).toMatchObject({
      isSystem: true,
      editable: false,
    });
  });

  test('ordinary files stay editable and non-system', () => {
    const { files } = listFiles(FOLDER);
    expect(files.find((f) => f.name === 'notes.md')).toMatchObject({
      isSystem: false,
      editable: true,
    });
  });
});
