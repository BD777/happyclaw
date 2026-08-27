import net from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';

import { downloadHttpsBuffer } from '../src/im-media-download.js';

function trackClose(server: net.Server): () => Promise<void> {
  const sockets = new Set<net.Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  };
}

async function listenBlackhole(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = net.createServer();
  const close = trackClose(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('blackhole server has no TCP port');
  }
  return { port: addr.port, close };
}

describe('Inbound IM media download timeout against a blackhole peer', () => {
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(closers.splice(0).map((close) => close()));
  }, 3000);

  test('Telegram-style GET rejects instead of hanging', async () => {
    const blackhole = await listenBlackhole();
    closers.push(blackhole.close);
    const started = Date.now();

    await expect(
      downloadHttpsBuffer(`http://127.0.0.1:${blackhole.port}/file/bot/photo`, {
        timeoutMs: 250,
      }),
    ).rejects.toThrow(/timed out/i);

    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('QQ-style redirect GET also times out on the follow-up hop', async () => {
    const blackhole = await listenBlackhole();
    closers.push(blackhole.close);

    const redirector = net.createServer((socket) => {
      socket.write(
        'HTTP/1.1 302 Found\r\n' +
          `Location: http://127.0.0.1:${blackhole.port}/cdn\r\n` +
          'Content-Length: 0\r\n\r\n',
      );
      socket.end();
    });
    closers.push(trackClose(redirector));
    await new Promise<void>((resolve, reject) => {
      redirector.once('error', reject);
      redirector.listen(0, '127.0.0.1', () => resolve());
    });
    const raddr = redirector.address();
    if (!raddr || typeof raddr === 'string') {
      throw new Error('redirector has no TCP port');
    }

    const started = Date.now();
    await expect(
      downloadHttpsBuffer(`http://127.0.0.1:${raddr.port}/attach`, {
        timeoutMs: 250,
        followRedirects: true,
      }),
    ).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
