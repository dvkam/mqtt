import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:net';
import { createTcpClient } from 'mqtt';

const peer = new EventEmitter();
/** @type {import('node:net').Socket | undefined} */
let connection;
/** @type {number[]} */
const commands = [];

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `socket` is typed `Socket`, and `Readonly<import('node:net').Socket>` still fails the rule, so the accepted type would be a hand-written list of the members used here, which has to change with every new use of `socket`. The deep read-only type in `src/util/bytes.ts` is not part of the published package, which is all this file imports. `Socket` is declared in `node:net`.
const server = createServer((socket) => {
  connection = socket;
  let buffered = Buffer.alloc(0);
  socket.on('error', (/** @type {Readonly<Error>} */ error) => {
    peer.emit('error', error);
  });
  socket.on('data', (/** @type {string | Readonly<Buffer<Readonly<ArrayBufferLike>>>} */ chunk) => {
    assert.ok(Buffer.isBuffer(chunk));
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 2) {
      const header = buffered.readUInt8(0);
      const remaining = buffered.readUInt8(1);
      assert.ok(remaining < 128, 'The test peer handles short control packets');
      const end = remaining + 2;
      if (buffered.length < end) return;
      const packet = buffered.subarray(0, end);
      buffered = buffered.subarray(end);
      commands.push(header);
      if (header === 0x10) {
        assert.equal(packet.readUInt16BE(10), 0, 'CONNECT still advertises Keep Alive 0');
        socket.write(Uint8Array.of(0x20, 6, 0, 0, 3, 0x13, 0, 1));
      } else if (header === 0xc0) {
        assert.equal(remaining, 0);
        socket.write(Uint8Array.of(0xd0, 0));
        peer.emit('ping');
      } else if (header === 0xe0) {
        socket.end();
        peer.emit('disconnect');
      } else throw new Error('Unexpected MQTT control packet');
    }
  });
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address !== null && typeof address !== 'string');
const signal = AbortSignal.timeout(4000);
try {
  const [client] = await Promise.all([
    createTcpClient({ host: '127.0.0.1', port: address.port, clientId: 'packed-keep-alive', signal }).connect(),
    once(peer, 'ping', { signal }),
  ]);
  await Promise.all([once(peer, 'disconnect', { signal }), client.disconnect()]);
  assert.deepEqual(commands, [0x10, 0xc0, 0xe0]);
  console.log('Packed TCP client sent PINGREQ for Server Keep Alive 1');
} finally {
  connection?.destroy();
  server.close();
}
