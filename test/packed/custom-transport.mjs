import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createConnection } from 'node:net';
import { createTransportClient, isMqttError, MqttError } from 'mqtt';

/** @param {import('node:stream').Duplex} stream @returns {import('mqtt').ByteTransport} */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- A Node Duplex has mutable stream state, and the adapter calls write, end and destroy on it.
function useDuplex(stream) {
  return {
    name: 'Duplex',
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ByteTransport.open in src/byteTransport.ts declares this ByteInbound and OpenContext, and OpenContext holds a native AbortSignal.
    async open(inbound, { timeoutMs }) {
      stream.on('data', inbound.bytes).on('end', inbound.end).on('error', inbound.fail);
      const closed = new Promise((resolve) => {
        stream.once('close', () => {
          inbound.end();
          resolve(undefined);
        });
      });
      return Promise.resolve({
        get bufferedBytes() {
          return stream.writableLength;
        },
        write: promisify(
          // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Writable.write in @types/node passes its callback a mutable Error.
          (/** @type {Readonly<Uint8Array>} */ bytes, /** @type {(error?: Readonly<Error> | null) => void} */ done) => {
            stream.write(bytes, done);
          },
        ),
        async close(force) {
          const timer = setTimeout(() => {
            stream.destroy();
          }, timeoutMs);
          try {
            if (force) stream.destroy();
            else stream.end();
            await closed;
          } finally {
            clearTimeout(timer);
          }
        },
      });
    },
  };
}

const port = Number(process.env['MQTT_TEST_PORT']);
assert.ok(Number.isInteger(port) && port > 0, 'Set MQTT_TEST_PORT to the disposable broker port');
const socket = createConnection({ host: '127.0.0.1', port });
try {
  await once(socket, 'connect', { signal: AbortSignal.timeout(3000) });
  /** @typedef {{readonly topic: string, readonly payload: {readonly toString: () => string}}} Echo */
  /** @type {(message: Echo) => void} */
  let receive = () => {};
  /** @type {Promise<Echo>} */
  const echo = new Promise((resolve) => {
    receive = resolve;
  });
  const factory = createTransportClient(useDuplex(socket), { clientId: 'packed-duplex', onMessage: receive });
  const connecting = factory.connect();
  assert.equal(factory.connect(), connecting, 'connect() must keep its promise');
  const client = await connecting;
  await client.subscribe('ci/duplex');
  await client.publish('ci/duplex', 'hello');
  await client.ping();
  const closed = once(socket, 'close', { signal: AbortSignal.timeout(3000) });
  const message = await Promise.race([
    echo,
    closed.then(() => {
      throw new Error('Duplex closed before echo');
    }),
  ]);
  assert.ok(Buffer.isBuffer(message.payload));
  assert.equal(message.topic, 'ci/duplex');
  assert.equal(message.payload.toString(), 'hello');
  await assert.rejects(
    client.subscribe('ci/duplex/#/invalid'),
    (error) => isMqttError(error, 'ERR_MQTT_INVALID_ARGUMENT') && !error.fatal,
  );
  await client.disconnect();
  await assert.rejects(client.ping(), (error) => error instanceof MqttError && error.code === 'ERR_MQTT_CLOSING' && error.fatal);
  console.log('Packed custom Duplex completed CONNECT, SUBSCRIBE, publish echo, PING and DISCONNECT with coded rejections');
} finally {
  socket.destroy();
}
