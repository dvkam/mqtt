// Behavior the ws client changed when it moved onto the byte transport core. docs/byte-transport.md lists each change.
import { expect, test } from 'vitest';
import { createWebSocketClient } from '../src/ws.js';

const options = { url: 'ws://127.0.0.1:9/mqtt', clientId: 'core-changes' };

test('an abort whose reason is not an Error names the WebSocket transport', async () => {
  const controller = new AbortController();
  controller.abort('stop');
  await expect(createWebSocketClient({ ...options, signal: controller.signal }).connect()).rejects.toMatchObject({
    name: 'AbortError',
    message: 'WebSocket connection aborted',
  });
});

test('the core validates the timeout before the write limits', async () => {
  await expect(createWebSocketClient({ ...options, timeoutMs: 0, maxBufferedBytes: 0 }).connect()).rejects.toThrow(
    'MQTT timeout must be a positive integer and fit in a timer',
  );
});

test('the core validates the packet limit before the WebSocket message limit', async () => {
  await expect(createWebSocketClient({ ...options, maxPacketBytes: 1, maxWebSocketMessageBytes: 0 }).connect()).rejects.toThrow(
    'MQTT packet capacity must be an integer from 2 to 268435460',
  );
});

test('an invalid WebSocket message limit alone still rejects before any socket opens', async () => {
  await expect(createWebSocketClient({ ...options, maxWebSocketMessageBytes: 0 }).connect()).rejects.toThrow(
    'WebSocket receive message limit must be an integer from 1 to 2147483647',
  );
});
