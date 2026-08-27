import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { afterEach, describe, expect, test } from 'vitest';

import {
  downloadHttpsBuffer,
  imMediaAgentForHop,
} from '../src/im-media-download.js';

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

  test('follows a relative redirect and accepts only the final 2xx body', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/media/file.bin' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end('payload');
    });
    closers.push(trackClose(server));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('missing HTTP port');

    await expect(
      downloadHttpsBuffer(`http://127.0.0.1:${addr.port}/start`, {
        followRedirects: true,
      }),
    ).resolves.toEqual(Buffer.from('payload'));
  });

  test('rejects unsupported schemes and terminal non-2xx responses', async () => {
    await expect(downloadHttpsBuffer('file:///etc/passwd')).rejects.toThrow(
      /unsupported.*protocol/i,
    );

    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end('not found');
    });
    closers.push(trackClose(server));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('missing HTTP port');

    await expect(
      downloadHttpsBuffer(`http://127.0.0.1:${addr.port}/missing`),
    ).rejects.toThrow(/HTTP 404/);
  });

  test('uses one absolute deadline across redirect latency and body latency', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/slow-redirect') {
        setTimeout(() => {
          res.writeHead(302, { location: '/slow-body' });
          res.end();
        }, 90).unref();
        return;
      }
      res.writeHead(200);
      res.write('partial');
      setTimeout(() => res.end('late'), 120).unref();
    });
    closers.push(trackClose(server));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('missing HTTP port');

    const started = Date.now();
    await expect(
      downloadHttpsBuffer(`http://127.0.0.1:${addr.port}/slow-redirect`, {
        timeoutMs: 150,
        followRedirects: true,
      }),
    ).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(300);
  });

  test('does not reuse a configured Agent after a protocol-changing redirect', () => {
    const agent = new http.Agent();
    expect(imMediaAgentForHop(agent, true)).toBe(agent);
    expect(imMediaAgentForHop(agent, false)).toBeUndefined();
    agent.destroy();
  });

  test('cross-protocol redirect reaches the new transport without the old Agent', async () => {
    const server = http.createServer((_req, res) => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('missing port');
      res.writeHead(302, {
        location: `https://127.0.0.1:${addr.port}/tls-target`,
      });
      res.end();
    });
    server.on('clientError', (_error, socket) => socket.destroy());
    closers.push(trackClose(server));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('missing HTTP port');
    const oldAgent = new http.Agent();
    try {
      const error = await downloadHttpsBuffer(
        `http://127.0.0.1:${addr.port}/redirect`,
        { agent: oldAgent, followRedirects: true, timeoutMs: 1000 },
      ).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect((error as NodeJS.ErrnoException).code).not.toBe(
        'ERR_INVALID_PROTOCOL',
      );
    } finally {
      oldAgent.destroy();
    }
  });

  test('turns a synchronous transport.get setup throw into Promise rejection', async () => {
    const wrongProtocolAgent = new https.Agent();
    try {
      await expect(
        downloadHttpsBuffer('http://127.0.0.1:1/file', {
          agent: wrongProtocolAgent,
        }),
      ).rejects.toThrow(/protocol/i);
    } finally {
      wrongProtocolAgent.destroy();
    }
  });

  test('keeps a redirect response tracked until its body ends', async () => {
    let targetRequests = 0;
    const server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/target' });
        res.write('body-that-never-finishes');
        return;
      }
      targetRequests += 1;
      res.end('unexpected');
    });
    closers.push(trackClose(server));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('missing HTTP port');

    await expect(
      downloadHttpsBuffer(`http://127.0.0.1:${addr.port}/redirect`, {
        timeoutMs: 120,
        followRedirects: true,
      }),
    ).rejects.toThrow(/timed out/i);
    expect(targetRequests).toBe(0);
  });
});
