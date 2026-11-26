// Run inside a project that installed the packed tarball without `ws`. npm does not install an optional peer dependency,
// so this is what a TCP-only or browser application gets.
import assert from 'node:assert/strict';

/** @param {unknown} error */
const missingWs = (error) =>
  error instanceof Error && 'code' in error && error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes("'ws'");

await assert.rejects(import('ws'), missingWs, 'ws must not be installed for this check');

const root = await import('mqtt');
assert.equal(typeof root.createTcpClient, 'function');
assert.equal(typeof root.createTransportClient, 'function');
assert.equal('createWebSocketClient' in root, false, 'the root entry must not export the ws client');
for (const entry of ['mqtt/browser', 'mqtt/codec']) await import(entry);
const portable = await import('mqtt/portable');
assert.equal(typeof portable.createTransportClient, 'function');
assert.equal('connectPortable' in portable, false, 'mqtt/portable must expose the byte transport');
assert.deepEqual(Object.keys(await import('mqtt/websocket')), [], 'mqtt/websocket must export types only');
assert.equal('openBrowserTransport' in (await import('mqtt/browser')), false, 'mqtt/browser must not export openBrowserTransport');
assert.equal(typeof (await import('mqtt/browser')).watchPageLifecycle, 'function');
for (const entry of [root, portable])
  assert.equal('watchPageLifecycle' in entry, false, 'only mqtt/browser exports watchPageLifecycle');

await assert.rejects(import('mqtt/ws'), missingWs, 'mqtt/ws must fail to load without ws');
console.log('Without ws installed, every entry but mqtt/ws loads, and mqtt/ws reports the missing ws package.');
