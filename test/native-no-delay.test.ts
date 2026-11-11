import { Socket } from 'node:net';
import tls from 'node:tls';
import { expect, test, vi } from 'vitest';
import { createTcpClient } from '../src/index.js';

test.each(['TCP', 'TLS'] as const)('%s disables Nagle buffering before opening completes', async (kind) => {
  const prototype = kind === 'TLS' ? tls.TLSSocket.prototype : Socket.prototype;
  const settings = vi.spyOn(prototype, 'setNoDelay');
  const controller = new AbortController();
  const cause = new Error('End the socket configuration test');
  const opening = createTcpClient({
    host: '127.0.0.1',
    port: 1,
    clientId: 'native-no-delay',
    tls: kind === 'TLS' ? {} : undefined,
    signal: controller.signal,
  })
    .connect()
    .catch((reason: unknown) => reason);
  try {
    expect(settings).toHaveBeenCalledWith(true);
  } finally {
    controller.abort(cause);
    expect(await opening).toBe(cause);
    settings.mockRestore();
  }
});
