import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { connect } from 'mqtt';
import { connectPortable } from 'mqtt/portable';
import { generate, parser } from 'mqtt-packet';

assert.equal(typeof connect, 'function');

const codec = { protocolVersion: 5 };
const socket = createConnection(Number(process.env.MQTT_TEST_PORT), '127.0.0.1');
const decoder = parser(codec);
socket.on('data', (chunk) => decoder.parse(chunk));
socket.on('error', () => socket.destroy());
decoder.on('error', () => socket.destroy());
const closed = once(socket, 'close');
closed.catch(() => {});

const transport = {
  send(packet) {
    return new Promise((resolve, reject) => {
      socket.write(generate(packet, codec), (error) => (error ? reject(error) : resolve()));
    });
  },
  listen(onPacket, onClose) {
    const notifyClose = () => onClose(new Error('Socket closed'));
    decoder.on('packet', onPacket);
    socket.on('close', notifyClose);
    return () => {
      decoder.off('packet', onPacket);
      socket.off('close', notifyClose);
    };
  },
  async close() {
    socket.end();
    await closed;
  },
};

let receive;
try {
  await once(socket, 'connect', { signal: AbortSignal.timeout(3000) });
  const client = await connectPortable(transport, {
    clientId: 'packed-ci',
    onMessage(packet) {
      receive?.(packet);
    },
  });
  await client.subscribe('ci/echo');
  const samples = [];
  const iterations = Number(process.env.MQTT_TEST_ITERATIONS ?? 1);
  const start = performance.now();
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    const received = new Promise((resolve) => {
      receive = resolve;
    });
    const timer = setTimeout(() => receive(undefined), 3000);
    try {
      await client.publish('ci/echo', String(index));
      const packet = await received;
      assert.equal(packet?.topic, 'ci/echo');
      assert.equal(packet.payload.toString(), String(index));
      assert.equal(packet.qos, 0);
      samples.push(performance.now() - started);
    } finally {
      clearTimeout(timer);
      receive = undefined;
    }
  }
  const elapsed = performance.now() - start;
  await client.disconnect();
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      iterations,
      echoPerSecond: (iterations * 1000) / elapsed,
      p99Ms: samples[Math.ceil(iterations * 0.99) - 1],
    }),
  );
} finally {
  socket.destroy();
}
