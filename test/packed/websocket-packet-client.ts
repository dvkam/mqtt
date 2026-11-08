import assert from 'node:assert/strict';
import { createWebSocketClient } from 'mqtt';
import { startWebSocketPacketPeer } from '../experiments/websocket-packet-peer.ts';

for (const mode of ['limit-connect', 'prefix-connect', 'tiny-messages', 'fragmented-limit', 'prefix-subscribe', 'eof-body']) {
  const peer = await startWebSocketPacketPeer(mode);
  try {
    const opening = createWebSocketClient({
      ...peer,
      clientId: mode,
      maxPacketBytes: mode === 'fragmented-limit' ? 130 : 8,
      maxWebSocketMessageBytes: mode === 'tiny-messages' ? 1 : 8,
    });
    if (mode.includes('connect')) await assert.rejects(opening.connect(), /MQTT packet allocation limit exceeded/);
    else {
      const client = await opening.connect();
      const operation = mode.includes('subscribe') ? client.subscribe('a') : client.ping();
      const reason = await operation.catch((failure: unknown) => failure);
      assert.ok(reason instanceof Error);
      assert.equal(
        reason.message,
        mode === 'eof-body' ? 'Truncated MQTT packet at end of input' : 'MQTT packet allocation limit exceeded',
      );
      await assert.rejects(client.publish('a', 'late'), (failure: unknown) => failure === reason);
    }
  } finally {
    await peer.close();
  }
}

const peer = await startWebSocketPacketPeer('mqtt-split');
try {
  let payload: Buffer | undefined;
  const client = await createWebSocketClient({
    ...peer,
    clientId: 'packed-split',
    maxPacketBytes: 8,
    maxWebSocketMessageBytes: 1,
    onMessage(packet: unknown) {
      if (typeof packet === 'object' && packet !== null && 'payload' in packet && Buffer.isBuffer(packet.payload))
        payload = packet.payload;
    },
  }).connect();
  await client.publish('a', 'test');
  await client.ping();
  assert.ok(payload !== undefined);
  assert.ok(payload.buffer.byteLength <= 8);
  payload[0] = 72;
  assert.equal(payload.toString(), 'Hi');
  await client.disconnect();
} finally {
  await peer.close();
}
console.log('packed WebSocket packet limits, split messages, EOF and Buffer ownership passed');
