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

export function imMediaAgentForHop(
  agent: http.Agent | https.Agent | undefined,
  configuredAgentAllowed: boolean,
): http.Agent | https.Agent | undefined {
  return configuredAgentAllowed ? agent : undefined;
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
    let deadlineTimer: NodeJS.Timeout;

    const finish = (error?: Error, value?: Buffer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      const request = activeRequest;
      const response = activeResponse;
      activeRequest = null;
      activeResponse = null;
      if (error) {
        response?.destroy();
        request?.destroy();
        reject(error);
      } else {
        resolve(value ?? Buffer.alloc(0));
      }
    };

    // One timer covers DNS/connect time, every redirect hop, and the complete
    // response body. Resetting a per-socket timeout at each hop would let a
    // redirect chain or trickle response hold an admitted turn indefinitely.
    deadlineTimer = setTimeout(
      () => {
        const error = new Error(
          `IM media download timed out after ${timeoutMs}ms`,
        );
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

    const doRequest = (
      requestUrl: URL,
      redirectCount: number,
      configuredAgentAllowed: boolean,
    ): void => {
      if (settled) return;
      if (redirectCount > 5) {
        finish(new Error('Too many redirects'));
        return;
      }

      const transport = requestUrl.protocol === 'https:' ? https : http;
      let req: http.ClientRequest;
      const onRequestError = (error: Error): void => finish(error);
      const onResponse = (res: http.IncomingMessage): void => {
        req.off('error', onRequestError);
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
            res.destroy();
            finish(
              error instanceof Error
                ? error
                : new Error('Invalid IM media redirect URL'),
            );
            return;
          }
          // A protocol switch cannot safely inherit an http.Agent/https.Agent
          // selected for the previous transport. Once crossed, keep using the
          // transport default even if a later redirect switches back.
          const nextAgentAllowed =
            configuredAgentAllowed && nextUrl.protocol === requestUrl.protocol;
          const continueRedirect = (): void => {
            if (settled) return;
            if (activeResponse === res) activeResponse = null;
            if (activeRequest === req) activeRequest = null;
            doRequest(nextUrl, redirectCount + 1, nextAgentAllowed);
          };
          res.once('error', (error) => finish(error));
          res.once('aborted', () =>
            finish(new Error('IM media redirect response aborted')),
          );
          res.once('close', () => {
            if (!settled && !res.complete) {
              finish(
                new Error('IM media redirect response closed before completion'),
              );
            }
          });
          res.once('end', continueRedirect);
          // Fully consume this response before replacing the tracked socket.
          // A redirect body that never ends is still bounded by deadlineTimer.
          res.resume();
          return;
        }

        if (status < 200 || status >= 300) {
          res.destroy();
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
            finish(error);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => finish(undefined, Buffer.concat(chunks)));
        res.on('error', (error) => finish(error));
        res.on('aborted', () =>
          finish(new Error('IM media response aborted before completion')),
        );
        res.on('close', () => {
          if (!settled && !res.complete) {
            finish(new Error('IM media response closed before completion'));
          }
        });
      };

      try {
        req = transport.get(
          requestUrl,
          {
            agent: imMediaAgentForHop(options.agent, configuredAgentAllowed),
          },
          onResponse,
        );
      } catch (error) {
        finish(
          error instanceof Error
            ? error
            : new Error('IM media request setup failed'),
        );
        return;
      }
      activeRequest = req;
      req.once('error', onRequestError);
    };

    try {
      doRequest(parseHttpUrl(url), 0, true);
    } catch (error) {
      finish(
        error instanceof Error ? error : new Error('Invalid IM media URL'),
      );
    }
  });
}
