import { createTcpClient } from '../dist/index.js';

let receive: ((payload: string) => void) | undefined;
const client = await createTcpClient({
  host: process.env['MQTT_HOST'] ?? '127.0.0.1',
  port: Number(process.env['MQTT_PORT'] ?? 1883),
  clientId: 'mqtt-typescript-example',
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The public callback receives the original mutable packet and Buffer.
  onMessage(packet) {
    receive?.(packet.payload.toString());
  },
}).connect();

let timer: ReturnType<typeof setTimeout> | undefined;
try {
  await client.subscribe('example/echo');
  const incoming = new Promise<string>((resolve, reject) => {
    receive = resolve;
    timer = setTimeout(() => {
      reject(new Error('MQTT echo timed out'));
    }, 5000);
  });
  // Observe a possible timeout even while publish is still pending.
  const exchange = Promise.all([incoming, client.publish('example/echo', 'hello')]);
  const [payload] = await exchange;
  console.log(payload);
  await client.ping();
} finally {
  clearTimeout(timer);
  receive = undefined;
  await client.disconnect();
}
