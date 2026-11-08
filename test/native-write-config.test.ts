import { expect, test, vi } from 'vitest';
import { createTcpClient } from '../src/tcpClient.js';
import { createWebSocketClient } from '../src/websocketClient.js';
import { createBrowserClient } from '../src/browserClient.js';
import type { NativeWriteLimits } from '../src/nativeWriteBudget.js';

test.each([
  { maxBufferedBytes: 0 },
  { maxBufferedBytes: -1 },
  { maxBufferedBytes: 1.5 },
  { maxBufferedBytes: NaN },
  { maxBufferedBytes: Infinity },
  { maxBufferedBytes: Number.MAX_SAFE_INTEGER + 1 },
  { reservedControlBytes: -1 },
  { reservedControlBytes: 0.5 },
  { reservedControlBytes: NaN },
  { reservedControlBytes: Infinity },
  { reservedControlBytes: Number.MAX_SAFE_INTEGER + 1 },
  { maxBufferedBytes: 8, reservedControlBytes: 9 },
])('rejects invalid native limits before endpoint access: %j', async (limits: Readonly<NativeWriteLimits>) => {
  const endpoint = vi.fn<() => never>(() => {
    throw new Error('endpoint accessed');
  });
  await expect(
    createTcpClient({
      ...limits,
      clientId: 'config',
      get host() {
        return endpoint();
      },
    }).connect(),
  ).rejects.toBeInstanceOf(RangeError);
  await expect(
    createWebSocketClient({
      ...limits,
      clientId: 'config',
      get url() {
        return endpoint();
      },
    }).connect(),
  ).rejects.toBeInstanceOf(RangeError);
  await expect(
    createBrowserClient({
      ...limits,
      clientId: 'config',
      get url() {
        return endpoint();
      },
    }).connect(),
  ).rejects.toBeInstanceOf(RangeError);
  expect(endpoint).not.toHaveBeenCalled();
});

test.each([
  { maxBufferedBytes: 1 },
  { maxBufferedBytes: 2 },
  { maxBufferedBytes: 3 },
  { maxBufferedBytes: 8, reservedControlBytes: 0 },
  { maxBufferedBytes: 8, reservedControlBytes: 8 },
  { maxBufferedBytes: Number.MAX_SAFE_INTEGER, reservedControlBytes: Number.MAX_SAFE_INTEGER },
])('accepts bounded native configuration: %j', async (limits: Readonly<NativeWriteLimits>) => {
  const marker = new Error('accepted endpoint');
  const host = {
    ...limits,
    clientId: 'config',
    get host(): string {
      throw marker;
    },
  };
  const url = {
    ...limits,
    clientId: 'config',
    get url(): string {
      throw marker;
    },
  };
  await expect(createTcpClient(host).connect()).rejects.toBe(marker);
  await expect(createWebSocketClient(url).connect()).rejects.toBe(marker);
  await expect(createBrowserClient(url).connect()).rejects.toBe(marker);
});

test.each(['tcp', 'websocket'] as const)('%s preserves pre-aborted precedence over invalid limits', async (kind) => {
  const reason = new Error('already aborted');
  const options = {
    host: 'unused',
    url: 'ws://unused',
    clientId: 'abort',
    signal: AbortSignal.abort(reason),
    reservedControlBytes: -1,
  };
  await expect((kind === 'tcp' ? createTcpClient(options) : createWebSocketClient(options)).connect()).rejects.toBe(reason);
});
