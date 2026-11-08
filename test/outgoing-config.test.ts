import { expect, test, vi } from 'vitest';
import { connectPortable, type PacketTransport } from '../src/portable.js';
import { createTcpClient } from '../src/tcpClient.js';
import { createWebSocketClient } from '../src/websocketClient.js';
import { createBrowserClient } from '../src/browserClient.js';

test.each(['maxPendingPublishes', 'maxPendingPublishBytes'] as const)('validates %s before acquisition', async (setting) => {
  for (const invalid of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const options = { clientId: 'invalid', [setting]: invalid };
    const listen = vi.fn<PacketTransport['listen']>(() => {
      throw new Error('registered');
    });
    const transport: PacketTransport = { listen, async send() {}, async close() {} };
    await expect(connectPortable(transport, options)).rejects.toBeInstanceOf(RangeError);
    expect(listen).not.toHaveBeenCalled();
    const endpoint = vi.fn<() => never>(() => {
      throw new Error('endpoint read');
    });
    await expect(
      createTcpClient({
        ...options,
        get host() {
          return endpoint();
        },
      }).connect(),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      createWebSocketClient({
        ...options,
        get url() {
          return endpoint();
        },
      }).connect(),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      createBrowserClient({
        ...options,
        get url() {
          return endpoint();
        },
      }).connect(),
    ).rejects.toBeInstanceOf(RangeError);
    expect(endpoint).not.toHaveBeenCalled();
  }
});
