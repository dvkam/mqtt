import assert from 'node:assert/strict';
import { createBrowserClient } from 'mqtt/browser';

// Runs the browser entry under Node's native WebSocket against a Mosquitto listener that requires a password.
const url = process.env['MQTT_TEST_PASSWORD_URL'] ?? 'ws://127.0.0.1:18890/mqtt';
const username = 'packed-user';

for (const password of ['packed-secret', new TextEncoder().encode('packed-secret')]) {
  const client = await createBrowserClient({ url, clientId: 'packed-password', username, password, timeoutMs: 3000 }).connect();
  await client.ping();
  await client.disconnect();
}

await assert.rejects(
  createBrowserClient({ url, clientId: 'packed-wrong-password', username, password: 'wrong', timeoutMs: 3000 }).connect(),
  (error) =>
    error instanceof Error &&
    'code' in error &&
    error.code === 'ERR_MQTT_REFUSED' &&
    'reasonCode' in error &&
    (error.reasonCode === 0x86 || error.reasonCode === 0x87),
);
console.log('Packed browser client authenticated with text and byte passwords and got a refusal for a wrong one');
