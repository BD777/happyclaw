import http from 'node:http';
import https from 'node:https';

import { MAX_FILE_SIZE } from './im-downloader.js';

/** Match QQ's outbound API budget so a blackhole CDN cannot hold an admitted turn. */
export const IM_MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;

export interface DownloadHttpsBufferOptions {
  agent?: http.Agent | https.Agent;
  timeoutMs?: number;
  maxBytes?: number;
  followRedirects?: boolean;
  oversizedMessage?: string;
}

export function downloadHttpsBuffer(
  url: string,
  options: DownloadHttpsBufferOptions = {},
): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? IM_MEDIA_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_FILE_SIZE;
  const followRedirects = options.followRedirects === true;
  const oversizedMessage =
    options.oversizedMessage ?? 'File exceeds MAX_FILE_SIZE';

  return new Promise<Buffer>((resolve, reject) => {
    const doRequest = (reqUrl: string, redirectCount: number) => {
      if (redirectCount > 5) {
        reject(new Error('Too many redirects'));
        return;
      }
      const parsed = new URL(reqUrl);
      const protocol = parsed.protocol === 'https:' ? https : http;
      const req = protocol.get(reqUrl, { agent: options.agent }, (res) => {
        if (
          followRedirects &&
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          res.resume();
          doRequest(res.headers.location, redirectCount + 1);
          return;
        }
        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > maxBytes) {
            res.destroy(new Error(oversizedMessage));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => {
        req.destroy(
          new Error(`IM media download timed out after ${timeoutMs}ms`),
        );
      });
    };
    doRequest(url, 0);
  });
}
