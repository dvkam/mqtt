import assert from 'node:assert/strict';
import { createTcpClient } from 'mqtt';
import { createWebSocketClient } from 'mqtt/ws';
import { checkWills } from './will-scenario.mjs';

const url = process.env['MQTT_TEST_WS_URL'];
const port = Number(process.env['MQTT_TEST_PORT']);
const transport = url === undefined ? 'TCP' : 'Node WebSocket';
assert.ok(url !== undefined || (Number.isInteger(port) && port > 0), 'Set MQTT_TEST_WS_URL or MQTT_TEST_PORT');
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Pass the caller's signal and byte options to the Node factory.
const notices = await checkWills((options) =>
  url === undefined ? createTcpClient({ ...options, host: '127.0.0.1', port }) : createWebSocketClient({ ...options, url }),
);
assert.deepEqual(notices, ['ci/will/abrupt', 'ci/will/with-will']);
console.log('Packed ' + transport + ' Will notifications passed');
