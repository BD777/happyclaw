import { create } from 'zustand';
import { api, apiFetch, computeUploadTimeoutMs } from '../api/client';

/**
 * 上传重试。慢速或不稳定链路上单次上传失败非常常见（反代读请求体超时 → 408，
 * 客户端 abort → 网络错误），此前任何一次失败都会让整批上传中断、用户必须
 * 手动从头再来。服务端按文件名 O_TRUNC 覆盖写，重传同一文件是幂等的。
 */
const UPLOAD_MAX_ATTEMPTS = 3;
const UPLOAD_RETRY_DELAYS_MS = [2000, 5000];

/**
 * 只重试传输层的瞬时失败：
 * - 0：apiFetch 归一化后的网络错误
 * - 408：客户端超时 abort，或反向代理读请求体超时
 * - 502/503/504：上游短暂不可用
 * 其余（400 参数错误、403 配额或路径拒绝、413 超限、500 逻辑错误）重试没有意义，
 * 立即失败，让用户看到真实原因而不是等三轮。
 */
function isRetriableUploadError(err: unknown): boolean {
  const status = (err as { status?: number } | null)?.status;
  return (
    status === 0 ||
    status === 408 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

/** apiFetch 抛出的 ApiError 是纯对象而非 Error，直接用 instanceof 会丢掉真实原因。 */
function uploadErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  const e = err as { message?: string; status?: number } | null;
  if (e?.message) {
    return e.status ? `${e.message} (HTTP ${e.status})` : e.message;
  }
  return 'Failed to upload files';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  modifiedAt: string;
  isSystem: boolean;
  /** 后端是否允许编辑内容。系统文件默认 false，工作区 CLAUDE.md 是例外。 */
  editable?: boolean;
  absolutePath?: string;
}

export interface UploadProgress {
  total: number;
  completed: number;
  currentFile: string;
  /** bytes for current batch */
  totalBytes: number;
  uploadedBytes: number;
  /** 当前文件的重试轮次；仅在 >1 时有值，用于让 UI 区分「慢」和「卡死」。 */
  attempt?: number;
}

interface FileState {
  files: Record<string, FileEntry[]>;
  currentPath: Record<string, string>;
  loading: boolean;
  uploading: boolean;
  uploadProgress: UploadProgress | null;
  error: string | null;

  loadFiles: (jid: string, path?: string) => Promise<void>;
  uploadFiles: (
    jid: string,
    files: File[],
    basePath?: string,
  ) => Promise<boolean>;
  deleteFile: (jid: string, filePath: string) => Promise<boolean>;
  createDirectory: (
    jid: string,
    parentPath: string,
    name: string,
  ) => Promise<void>;
  navigateTo: (jid: string, path: string) => void;
  getFileContent: (jid: string, filePath: string) => Promise<string | null>;
  saveFileContent: (
    jid: string,
    filePath: string,
    content: string,
  ) => Promise<boolean>;
}

export function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export const useFileStore = create<FileState>((set, get) => ({
  files: {},
  currentPath: {},
  loading: false,
  uploading: false,
  uploadProgress: null,
  error: null,

  loadFiles: async (jid: string, path?: string) => {
    set({ loading: true, error: null });
    try {
      const targetPath =
        path !== undefined ? path : get().currentPath[jid] || '';
      const params = new URLSearchParams();
      if (targetPath) params.set('path', targetPath);

      const data = await api.get<{ files: FileEntry[]; currentPath: string }>(
        `/api/groups/${encodeURIComponent(jid)}/files?${params}`,
      );

      set((s) => ({
        files: { ...s.files, [jid]: data.files },
        currentPath: { ...s.currentPath, [jid]: data.currentPath },
        loading: false,
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load files';
      console.error('Failed to load files:', err);
      set({ loading: false, error: msg });
    }
  },

  uploadFiles: async (jid: string, files: File[], basePath?: string) => {
    if (files.length === 0) return false;

    const total = files.length;
    const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
    set({
      uploading: true,
      uploadProgress: {
        total,
        completed: 0,
        currentFile: files[0].name,
        totalBytes,
        uploadedBytes: 0,
      },
    });

    const targetBase =
      basePath !== undefined ? basePath : get().currentPath[jid] || '';
    const apiUrl = `/api/groups/${encodeURIComponent(jid)}/files`;
    let uploadedBytes = 0;

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];

        // For folder uploads, webkitRelativePath = "folderName/sub/file.txt"
        // Extract directory portion to preserve structure
        const relativePath = file.webkitRelativePath;
        let uploadPath = targetBase;
        if (relativePath) {
          const lastSlash = relativePath.lastIndexOf('/');
          if (lastSlash > 0) {
            const dir = relativePath.substring(0, lastSlash);
            uploadPath = targetBase ? `${targetBase}/${dir}` : dir;
          }
        }

        set({
          uploadProgress: {
            total,
            completed: i,
            currentFile: file.name,
            totalBytes,
            uploadedBytes,
          },
        });

        // 每轮重建 FormData：body 已被上一次 fetch 消费，不能复用。
        let lastErr: unknown;
        for (let attempt = 1; attempt <= UPLOAD_MAX_ATTEMPTS; attempt++) {
          if (attempt > 1) {
            set({
              uploadProgress: {
                total,
                completed: i,
                currentFile: file.name,
                totalBytes,
                uploadedBytes,
                attempt,
              },
            });
          }

          const formData = new FormData();
          formData.append('files', file);
          if (uploadPath) formData.append('path', uploadPath);

          try {
            await apiFetch(apiUrl, {
              method: 'POST',
              body: formData,
              headers: {},
              timeoutMs: computeUploadTimeoutMs(file.size),
            });
            lastErr = undefined;
            break;
          } catch (err) {
            lastErr = err;
            if (
              attempt === UPLOAD_MAX_ATTEMPTS ||
              !isRetriableUploadError(err)
            ) {
              break;
            }
            await sleep(UPLOAD_RETRY_DELAYS_MS[attempt - 1] ?? 5000);
          }
        }
        if (lastErr) throw lastErr;

        uploadedBytes += file.size;

        set({
          uploadProgress: {
            total,
            completed: i + 1,
            currentFile: i + 1 < total ? files[i + 1].name : '',
            totalBytes,
            uploadedBytes,
          },
        });
      }

      // Reload file list
      await get().loadFiles(jid, targetBase);
      return true;
    } catch (err) {
      const msg = uploadErrorMessage(err);
      console.error('Failed to upload files:', err);
      set({ error: msg });
      return false;
    } finally {
      set({ uploading: false, uploadProgress: null });
    }
  },

  deleteFile: async (jid: string, filePath: string) => {
    try {
      const encoded = toBase64Url(filePath);
      await api.delete(
        `/api/groups/${encodeURIComponent(jid)}/files/${encoded}`,
      );

      const currentPath = get().currentPath[jid] || '';
      await get().loadFiles(jid, currentPath);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete file';
      console.error('Failed to delete file:', err);
      set({ error: msg });
      return false;
    }
  },

  createDirectory: async (jid: string, parentPath: string, name: string) => {
    try {
      await api.post(`/api/groups/${encodeURIComponent(jid)}/directories`, {
        path: parentPath,
        name,
      });

      await get().loadFiles(jid, parentPath);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Failed to create directory';
      console.error('Failed to create directory:', err);
      set({ error: msg });
    }
  },

  navigateTo: (jid: string, path: string) => {
    set((s) => ({
      currentPath: { ...s.currentPath, [jid]: path },
      files: { ...s.files, [jid]: [] },
    }));
    get().loadFiles(jid, path);
  },

  getFileContent: async (jid: string, filePath: string) => {
    try {
      const encoded = toBase64Url(filePath);
      const data = await api.get<{ content: string }>(
        `/api/groups/${encodeURIComponent(jid)}/files/content/${encoded}`,
      );
      return data.content;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to read file';
      console.error('Failed to read file content:', err);
      set({ error: msg });
      return null;
    }
  },

  saveFileContent: async (jid: string, filePath: string, content: string) => {
    try {
      const encoded = toBase64Url(filePath);
      await api.put(
        `/api/groups/${encodeURIComponent(jid)}/files/content/${encoded}`,
        { content },
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save file';
      console.error('Failed to save file content:', err);
      set({ error: msg });
      return false;
    }
  },
}));
