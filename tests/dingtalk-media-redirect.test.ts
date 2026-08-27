import http from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';

import { downloadDingTalkHttpBuffer } from '../src/dingtalk.js';

const servers: http.Server[] = [];

async function listen(
  handler: http.RequestListener,
): Promise<{ server: http.Server; origin: string }> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe('DingTalk bounded media redirects', () => {
  test('resolves a relative redirect against the current URL', async () => {
    const { origin } = await listen((req, res) => {
      if (req.url === '/nested/start') {
        res.writeHead(302, { location: '../final?token=1' });
        res.end('redirect-body-that-must-be-drained');
        return;
      }
      expect(req.url).toBe('/final?token=1');
      res.end('media-bytes');
    });

    await expect(
      downloadDingTalkHttpBuffer(`${origin}/nested/start`),
    ).resolves.toEqual(Buffer.from('media-bytes'));
  });

  test.each(['http://[', 'file:///tmp/secret'])(
    'rejects unsafe redirect %s',
    async (location) => {
      const { origin } = await listen((_req, res) => {
        res.writeHead(302, { location });
        res.end();
      });

      await expect(
        downloadDingTalkHttpBuffer(`${origin}/start`),
      ).rejects.toThrow(
        /Invalid DingTalk media redirect URL|Unsupported DingTalk media protocol/,
      );
    },
  );

  test('enforces an absolute byte ceiling while streaming', async () => {
    const { origin } = await listen((_req, res) => {
      res.write(Buffer.alloc(8, 1));
      res.end(Buffer.alloc(8, 2));
    });

    await expect(downloadDingTalkHttpBuffer(origin, 10)).rejects.toThrow(
      'download byte limit',
    );
  });

  test('actively closes a replaced redirect response that keeps writing', async () => {
    let redirectClosed = false;
    const { origin } = await listen((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/final' });
        res.flushHeaders();
        const writer = setInterval(() => res.write(Buffer.alloc(1024)), 1);
        res.on('close', () => {
          clearInterval(writer);
          redirectClosed = true;
        });
        return;
      }
      res.end('final');
    });

    await expect(
      downloadDingTalkHttpBuffer(`${origin}/start`),
    ).resolves.toEqual(Buffer.from('final'));
    await expect.poll(() => redirectClosed).toBe(true);
  });

  test('actively closes a declared-oversize response that keeps writing', async () => {
    let responseClosed = false;
    const { origin } = await listen((_req, res) => {
      res.writeHead(200, { 'content-length': 1_000_000 });
      res.flushHeaders();
      const writer = setInterval(() => res.write(Buffer.alloc(1024)), 1);
      res.on('close', () => {
        clearInterval(writer);
        responseClosed = true;
      });
    });

    await expect(downloadDingTalkHttpBuffer(origin, 10)).rejects.toThrow(
      'download byte limit',
    );
    await expect.poll(() => responseClosed).toBe(true);
  });
});
