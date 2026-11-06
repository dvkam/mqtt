import assert from 'node:assert/strict';
import { createTcpClient } from 'mqtt';

let receive;
const client = await createTcpClient({
  host: '127.0.0.1',
  port: Number(process.env.MQTT_TEST_PORT),
  clientId: 'packed-ci',
  onMessage(packet) {
    receive?.(packet);
  },
}).connect();
try {
  await client.subscribe('ci/echo');
  await client.ping();
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
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      iterations,
      echoPerSecond: (iterations * 1000) / elapsed,
      p99Ms: samples[Math.ceil(iterations * 0.99) - 1],
    }),
  );
} finally {
  await client.disconnect();
}
