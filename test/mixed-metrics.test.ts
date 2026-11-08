import { createConnection, createServer, Socket } from 'node:net';
import { once } from 'node:events';
import { PerformanceObserver } from 'node:perf_hooks';
import { afterEach, expect, test, vi } from 'vitest';
import * as metrics from './experiments/mixed-traffic-metrics.js';
import * as peers from './experiments/mixed-traffic-peer.js';
import { runMixedTrafficProbe } from './experiments/mixed-traffic.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test('metric shutdown failure preserves its cause and still closes the peer', async () => {
  const marker = new Error('metric shutdown rejected');
  const observe = metrics.observeProbe;
  const startPeer = peers.startMixedTrafficPeer;
  let peer: Awaited<ReturnType<typeof startPeer>> | undefined;
  const close = vi.fn<() => Promise<void>>(async () => {});
  vi.spyOn(peers, 'startMixedTrafficPeer').mockImplementation(async (options) => {
    peer = await startPeer(options);
    const original = peer.close.bind(peer);
    peer.close = async () => {
      await close();
      await original();
    };
    return peer;
  });
  vi.spyOn(metrics, 'observeProbe').mockImplementation((port) => {
    const observation = observe(port);
    return {
      async stop() {
        await observation.stop();
        throw marker;
      },
    };
  });
  try {
    await expect(runMixedTrafficProbe({ transport: 'tcp', rounds: 1, observerIterations: 0 })).rejects.toBe(marker);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    if (peer) await peer.close();
  }
});

test('metric setup failure leaves native write ownership available for another run', async () => {
  const marker = new Error('metric setup rejected');
  // oxlint-disable-next-line typescript/unbound-method -- The test compares and restores exact native method identity.
  const original = Socket.prototype.write;
  const observe = vi.spyOn(PerformanceObserver.prototype, 'observe').mockImplementation(() => {
    throw marker;
  });
  try {
    await expect(runMixedTrafficProbe({ transport: 'tcp', rounds: 1, observerIterations: 0 })).rejects.toBe(marker);
    observe.mockRestore();
    expect(Socket.prototype.write === original).toBe(true);
    const result = await runMixedTrafficProbe({ transport: 'tcp', rounds: 1, observerIterations: 0 });
    expect(result.accepted).toBe(8);
  } finally {
    Socket.prototype.write = original;
  }
});

test('native observation measures a known corked write and restores its hook', async () => {
  let peer: Socket | undefined;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture owns this native TCP connection.
  const server = createServer((socket) => {
    peer = socket;
    socket.resume();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected address');
  const connected = once(server, 'connection');
  const client = createConnection({ host: '127.0.0.1', port: address.port });
  await Promise.all([once(client, 'connect'), connected]);
  const observation = metrics.observeProbe(address.port);
  try {
    client.cork();
    client.write(Buffer.alloc(10));
    const result = await observation.stop();
    expect(result.nativeObservedPeakBytes).toBe(10);
    expect(result.nativeWriteSamples).toBe(2);
  } finally {
    client.uncork();
    client.destroy();
    peer?.destroy();
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  }
});

test('memory sampling records baseline, interval peak and final observation', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const usage = (value: number) => ({ rss: value, heapTotal: value, heapUsed: value, external: value, arrayBuffers: value });
  vi.spyOn(process, 'memoryUsage')
    .mockReturnValueOnce(usage(100))
    .mockReturnValueOnce(usage(200))
    .mockReturnValueOnce(usage(500))
    .mockReturnValueOnce(usage(150));
  const observation = metrics.observeProbe(0);
  vi.advanceTimersByTime(10);
  const result = await observation.stop();
  expect(result.memory).toEqual({ samples: 3, intervalMs: 10, baseline: usage(100), sampledPeak: usage(500), last: usage(150) });
});

test('failed final memory sampling restores native ownership and permits another observation', async () => {
  const observation = metrics.observeProbe(0);
  const marker = new Error('final memory sample failed');
  const memory = vi.spyOn(process, 'memoryUsage').mockImplementation(() => {
    throw marker;
  });
  await expect(observation.stop()).rejects.toBe(marker);
  memory.mockRestore();
  const next = metrics.observeProbe(0);
  const result = await next.stop();
  expect(result.memory.samples).toBe(2);
});
