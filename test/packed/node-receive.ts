import assert from 'node:assert/strict';
import { createWebSocketClient } from 'mqtt';

const endpoint = process.argv[2];
assert.ok(endpoint !== undefined, 'Expected receive-test endpoint');
for (const mode of ['exact', 'ws-fragments', 'mqtt-split', 'coalesced']) {
  const messages: string[] = [];
  const client = await createWebSocketClient({
    url: endpoint + '/?mode=' + mode,
    clientId: mode,
    maxWebSocketMessageBytes: mode === 'mqtt-split' ? 4 : mode === 'coalesced' ? 16 : 8,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- This consumer checks the installed mutable Buffer contract.
    onMessage(packet) {
      messages.push(packet.payload.toString());
    },
  }).connect();
  try {
    await client.publish('a', 'test');
    await client.ping();
    assert.deepEqual(messages, mode === 'coalesced' ? ['hi', 'hi'] : ['hi']);
  } finally {
    await client.disconnect();
  }
}
for (const mode of [
  'oversized-connect',
  'suback-overflow',
  'ping-overflow',
  'partial-overflow',
  'ws-fragments-overflow',
  'stalled-close',
]) {
  let delivered = 0;
  const opening = createWebSocketClient({
    url: endpoint + '/?mode=' + mode,
    clientId: mode,
    maxWebSocketMessageBytes: 8,
    timeoutMs: 500,
    onMessage() {
      delivered++;
    },
  }).connect();
  let failure: unknown;
  if (mode === 'oversized-connect') failure = await opening.catch((reason: unknown) => reason);
  else {
    const client = await opening;
    try {
      failure = await (mode === 'suback-overflow' ? client.subscribe('a') : client.ping()).catch((reason: unknown) => reason);
      await assert.rejects(client.publish('a', 'late'), (reason: unknown) => reason === failure);
    } finally {
      await client.disconnect().catch((reason: unknown) => {
        if (reason !== failure) throw reason;
      });
    }
  }
  assert.ok(failure instanceof RangeError);
  assert.ok('code' in failure && failure.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH');
  assert.equal(delivered, 0);
}
console.log('packed Node WebSocket receive limits passed');
