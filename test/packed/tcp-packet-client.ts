import assert from 'node:assert/strict';
import { createTcpClient } from 'mqtt';
import { startTcpPacketPeer } from '../experiments/tcp-packet-peer.ts';

for (const mode of ['limit-connect', 'prefix-connect']) {
  const peer = await startTcpPacketPeer(mode);
  try {
    await assert.rejects(createTcpClient({ ...peer, clientId: mode, maxPacketBytes: 8 }).connect(), {
      name: 'RangeError',
      message: 'MQTT packet allocation limit exceeded',
    });
  } finally {
    await peer.close();
  }
}

for (const mode of ['limit-ping', 'prefix-subscribe', 'fragmented-limit', 'eof-body', 'blocked-write-eof']) {
  const peer = await startTcpPacketPeer(mode);
  try {
    const client = await createTcpClient({
      ...peer,
      clientId: mode,
      maxPendingPublishBytes: 16 * 1024 * 1024,
      maxPacketBytes: mode === 'fragmented-limit' ? 130 : 8,
    }).connect();
    const operation =
      mode === 'blocked-write-eof'
        ? client.publish('a', 'x'.repeat(8 * 1024 * 1024))
        : mode === 'prefix-subscribe'
          ? client.subscribe('a')
          : client.ping();
    const reason = await operation.catch((failure: unknown) => failure);
    assert.ok(reason instanceof Error);
    assert.equal(
      reason.message,
      mode.includes('eof') ? 'Truncated MQTT packet at end of input' : 'MQTT packet allocation limit exceeded',
    );
    await assert.rejects(client.publish('a', 'late'), (failure: unknown) => failure === reason);
  } finally {
    await peer.close();
  }
}

const peer = await startTcpPacketPeer('exact');
try {
  let payload: Buffer | undefined;
  const client = await createTcpClient({
    ...peer,
    clientId: 'packed-exact',
    maxPacketBytes: 8,
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
console.log('packed TCP packet capacity, EOF and Buffer ownership passed');
