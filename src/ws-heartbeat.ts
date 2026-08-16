/**
 * WebSocket 心跳：保活 + 死连接回收。
 *
 * 解决两个问题：
 *
 * 1) 保活。反向代理与 NAT 会掐掉空闲的 upgraded 连接（nginx proxy_read_timeout
 *    默认 60s，Cloudflare 100s，运营商 NAT 常见 30~120s）。没有心跳时前端会被
 *    动辄每分钟断开一次，反复弹出「连接中断，正在重连...」。服务端定期 ping 让
 *    连接始终有真实流量，读超时不会触发；浏览器由协议栈自动回 pong，前端无需
 *    任何改动。
 *
 * 2) 死连接回收。客户端非正常消失（合盖、切网、进程被杀）时 TCP 半开，'close'
 *    永不触发，连接表条目与终端会话会一直泄漏，广播持续写入黑洞。只有 ping/pong
 *    探测能发现这种连接。
 *
 * 关于 maxMissedPongs 的取值：代价高度不对称。误杀活连接会让用户看到
 * 「连接中断，正在重连...」——正是本心跳要消除的现象；而晚回收死连接只是多留
 * 一个条目和几 KB 无效广播。主服务是单进程，存在同步写盘（如文件上传）与 GC
 * 停顿，事件循环被阻塞时 pong 帧虽已到达却来不及处理，取 1（ws 库 README 示例
 * 的经典写法）会把这种停顿误判成死连接并踢掉全部客户端。因此默认取 3。
 */

/** 心跳只需要这三个能力，用结构类型以便测试替身注入。 */
export interface HeartbeatSocket {
  ping(): void;
  terminate(): void;
  on(event: 'pong', listener: () => void): unknown;
}

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_MISSED_PONGS = 3;

export interface HeartbeatOptions {
  intervalMs?: number;
  /** 连续多少轮收不到 pong 判定连接已死。必须 >= 1。 */
  maxMissedPongs?: number;
}

export interface WebSocketHeartbeat {
  readonly intervalMs: number;
  readonly maxMissedPongs: number;
  /** 登记一条新连接，并挂上 pong 监听。 */
  track(socket: HeartbeatSocket): void;
  /** 执行一轮探测，返回本轮被判定为死连接并已 terminate 的数量。 */
  sweep(sockets: Iterable<HeartbeatSocket>): number;
}

export function createWebSocketHeartbeat(
  options: HeartbeatOptions = {},
): WebSocketHeartbeat {
  const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const maxMissedPongs = Math.max(
    1,
    options.maxMissedPongs ?? DEFAULT_MAX_MISSED_PONGS,
  );
  // WeakMap：连接被回收后条目自动消失，不会成为新的泄漏点。
  const missedPongs = new WeakMap<HeartbeatSocket, number>();

  return {
    intervalMs,
    maxMissedPongs,

    track(socket) {
      missedPongs.set(socket, 0);
      socket.on('pong', () => missedPongs.set(socket, 0));
    },

    sweep(sockets) {
      let terminated = 0;
      for (const socket of sockets) {
        const missed = (missedPongs.get(socket) ?? 0) + 1;
        if (missed >= maxMissedPongs) {
          // terminate() 会触发 'close'，由调用方既有的 close handler 完成
          // 连接表与终端会话清理。
          terminated += 1;
          try {
            socket.terminate();
          } catch {
            /* ignore */
          }
          continue;
        }
        missedPongs.set(socket, missed);
        try {
          socket.ping();
        } catch {
          /* ignore */
        }
      }
      return terminated;
    },
  };
}
