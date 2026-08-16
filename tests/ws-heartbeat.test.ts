import { describe, expect, test, vi } from 'vitest';
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_MAX_MISSED_PONGS,
  createWebSocketHeartbeat,
  type HeartbeatSocket,
} from '../src/ws-heartbeat.js';

/** 测试替身：记录 ping/terminate 次数，并能按需回 pong。 */
function fakeSocket() {
  let pongListener: (() => void) | undefined;
  const socket = {
    ping: vi.fn(),
    terminate: vi.fn(),
    on: vi.fn((event: 'pong', listener: () => void) => {
      if (event === 'pong') pongListener = listener;
      return socket;
    }),
    /** 模拟对端回 pong */
    respond: () => pongListener?.(),
  };
  return socket;
}

type FakeSocket = ReturnType<typeof fakeSocket>;

const asSockets = (...sockets: FakeSocket[]): HeartbeatSocket[] =>
  sockets as unknown as HeartbeatSocket[];

describe('createWebSocketHeartbeat', () => {
  test('默认 30s 间隔、容忍 3 轮——刻意宽于 ws 库示例的 1 轮', () => {
    const heartbeat = createWebSocketHeartbeat();
    expect(heartbeat.intervalMs).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
    expect(heartbeat.intervalMs).toBe(30_000);
    // 单进程服务存在同步写盘与 GC 停顿，取 1 会把事件循环阻塞误判成死连接
    // 并踢掉全部客户端。这个下限是回归保护，不要调回 1。
    expect(heartbeat.maxMissedPongs).toBe(DEFAULT_MAX_MISSED_PONGS);
    expect(heartbeat.maxMissedPongs).toBe(3);
  });

  test('track 会登记连接并挂上 pong 监听', () => {
    const heartbeat = createWebSocketHeartbeat();
    const socket = fakeSocket();

    heartbeat.track(socket as unknown as HeartbeatSocket);

    expect(socket.on).toHaveBeenCalledWith('pong', expect.any(Function));
  });

  test('每轮对存活连接发 ping，且不终止它们', () => {
    const heartbeat = createWebSocketHeartbeat();
    const socket = fakeSocket();
    heartbeat.track(socket as unknown as HeartbeatSocket);

    const terminated = heartbeat.sweep(asSockets(socket));

    expect(socket.ping).toHaveBeenCalledTimes(1);
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(terminated).toBe(0);
  });

  test('持续回 pong 的连接永远不会被终止', () => {
    const heartbeat = createWebSocketHeartbeat();
    const socket = fakeSocket();
    heartbeat.track(socket as unknown as HeartbeatSocket);

    for (let round = 0; round < 20; round++) {
      expect(heartbeat.sweep(asSockets(socket))).toBe(0);
      socket.respond();
    }

    expect(socket.terminate).not.toHaveBeenCalled();
    expect(socket.ping).toHaveBeenCalledTimes(20);
  });

  test('连续 3 轮无 pong 才终止——前两轮只探测', () => {
    const heartbeat = createWebSocketHeartbeat();
    const socket = fakeSocket();
    heartbeat.track(socket as unknown as HeartbeatSocket);

    expect(heartbeat.sweep(asSockets(socket))).toBe(0);
    expect(socket.terminate).not.toHaveBeenCalled();

    expect(heartbeat.sweep(asSockets(socket))).toBe(0);
    expect(socket.terminate).not.toHaveBeenCalled();

    expect(heartbeat.sweep(asSockets(socket))).toBe(1);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    // 判定为死连接后不再浪费一次 ping
    expect(socket.ping).toHaveBeenCalledTimes(2);
  });

  test('中途恢复 pong 会清零计数，不会累积到终止', () => {
    const heartbeat = createWebSocketHeartbeat();
    const socket = fakeSocket();
    heartbeat.track(socket as unknown as HeartbeatSocket);

    heartbeat.sweep(asSockets(socket)); // missed = 1
    heartbeat.sweep(asSockets(socket)); // missed = 2
    socket.respond(); // 事件循环恢复，pong 被处理 → 清零

    expect(heartbeat.sweep(asSockets(socket))).toBe(0);
    expect(heartbeat.sweep(asSockets(socket))).toBe(0);
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  test('未经 track 的连接同样被计数，不会因缺省状态被立即终止', () => {
    const heartbeat = createWebSocketHeartbeat();
    const socket = fakeSocket();

    expect(heartbeat.sweep(asSockets(socket))).toBe(0);
    expect(socket.ping).toHaveBeenCalledTimes(1);
  });

  test('maxMissedPongs 可配置，且下限被钳制为 1', () => {
    const eager = createWebSocketHeartbeat({ maxMissedPongs: 1 });
    const socket = fakeSocket();
    eager.track(socket as unknown as HeartbeatSocket);
    expect(eager.sweep(asSockets(socket))).toBe(1);

    // 0 / 负数会让每一轮都立即终止全部连接，钳制到 1 是安全下限
    expect(createWebSocketHeartbeat({ maxMissedPongs: 0 }).maxMissedPongs).toBe(
      1,
    );
    expect(
      createWebSocketHeartbeat({ maxMissedPongs: -5 }).maxMissedPongs,
    ).toBe(1);
  });

  test('单个连接 ping 抛错不影响同一轮的其他连接', () => {
    const heartbeat = createWebSocketHeartbeat();
    const broken = fakeSocket();
    broken.ping.mockImplementation(() => {
      throw new Error('socket already closed');
    });
    const healthy = fakeSocket();
    heartbeat.track(broken as unknown as HeartbeatSocket);
    heartbeat.track(healthy as unknown as HeartbeatSocket);

    expect(() => heartbeat.sweep(asSockets(broken, healthy))).not.toThrow();
    expect(healthy.ping).toHaveBeenCalledTimes(1);
  });

  test('terminate 抛错不影响同一轮的其他连接', () => {
    const heartbeat = createWebSocketHeartbeat({ maxMissedPongs: 1 });
    const broken = fakeSocket();
    broken.terminate.mockImplementation(() => {
      throw new Error('already destroyed');
    });
    const healthy = fakeSocket();

    expect(() => heartbeat.sweep(asSockets(broken, healthy))).not.toThrow();
    expect(healthy.terminate).toHaveBeenCalledTimes(1);
  });

  test('多连接独立计数：死连接被清理，活连接不受牵连', () => {
    const heartbeat = createWebSocketHeartbeat();
    const dead = fakeSocket();
    const alive = fakeSocket();
    heartbeat.track(dead as unknown as HeartbeatSocket);
    heartbeat.track(alive as unknown as HeartbeatSocket);

    for (let round = 0; round < 2; round++) {
      heartbeat.sweep(asSockets(dead, alive));
      alive.respond();
    }
    const terminated = heartbeat.sweep(asSockets(dead, alive));

    expect(terminated).toBe(1);
    expect(dead.terminate).toHaveBeenCalledTimes(1);
    expect(alive.terminate).not.toHaveBeenCalled();
  });
});
