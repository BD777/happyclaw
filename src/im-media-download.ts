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
    let settled = false;
    let activeRequest: http.ClientRequest | null = null;
    let activeResponse: http.IncomingMessage | null = null;

    const finish = (error?: Error, value?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      activeRequest = null;
      activeResponse = null;
      if (error) reject(error);
      else resolve(value ?? Buffer.alloc(0));
    };

    // One timer covers DNS/connect time, every redirect hop, and the complete
    // response body. Resetting a per-socket timeout at each hop would let a
    // redirect chain or trickle response hold an admitted turn indefinitely.
    const deadlineTimer = setTimeout(
      () => {
        const error = new Error(
          `IM media download timed out after ${timeoutMs}ms`,
        );
        activeResponse?.destroy(error);
        activeRequest?.destroy(error);
        finish(error);
      },
      Math.max(0, timeoutMs),
    );

    const parseHttpUrl = (raw: string | URL, base?: URL): URL => {
      const parsed = raw instanceof URL ? raw : new URL(raw, base);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(
          `Unsupported IM media URL protocol: ${parsed.protocol || '<none>'}`,
        );
      }
      return parsed;
    };

    const doRequest = (requestUrl: URL, redirectCount: number): void => {
      if (settled) return;
      if (redirectCount > 5) {
        finish(new Error('Too many redirects'));
        return;
      }

      const transport = requestUrl.protocol === 'https:' ? https : http;
      const req = transport.get(requestUrl, { agent: options.agent }, (res) => {
        if (settled) {
          res.destroy();
          return;
        }
        activeResponse = res;
        const status = res.statusCode ?? 0;
        const isRedirect = status >= 300 && status < 400;
        if (followRedirects && isRedirect && res.headers.location) {
          let nextUrl: URL;
          try {
            nextUrl = parseHttpUrl(res.headers.location, requestUrl);
          } catch (error) {
            res.resume();
            finish(
              error instanceof Error
                ? error
                : new Error('Invalid IM media redirect URL'),
            );
            return;
          }
          res.resume();
          activeResponse = null;
          activeRequest = null;
          doRequest(nextUrl, redirectCount + 1);
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          finish(new Error(`IM media download HTTP ${status || 'unknown'}`));
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        res.on('data', (rawChunk: Buffer | Uint8Array | string) => {
          const chunk = Buffer.isBuffer(rawChunk)
            ? rawChunk
            : Buffer.from(rawChunk);
          total += chunk.length;
          if (total > maxBytes) {
            const error = new Error(oversizedMessage);
            res.destroy(error);
            finish(error);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => finish(undefined, Buffer.concat(chunks)));
        res.on('error', (error) => finish(error));
      });
      activeRequest = req;
      req.on('error', (error) => finish(error));
    };

    try {
      doRequest(parseHttpUrl(url), 0);
    } catch (error) {
      finish(
        error instanceof Error ? error : new Error('Invalid IM media URL'),
      );
    }
  });
}
