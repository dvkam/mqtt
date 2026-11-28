import assert from 'node:assert/strict';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { createFixture } from './page-lifecycle-fixture.ts';

// Serves the page of the manual checks in docs/page-lifecycle.md to other devices, and prints each change of the
// connections that the proxy in front of the broker holds.

const inputRoot = process.argv[2];
assert.ok(inputRoot !== undefined && inputRoot !== '', 'Expected packed consumer directory');
const brokerUrl = new URL(process.argv[3] ?? '');
assert.equal(brokerUrl.protocol, 'ws:', 'Expected a ws:// broker URL');
const fixture = await createFixture(resolve(inputRoot), brokerUrl, '0.0.0.0');
const port = new URL(fixture.origin).port;
for (const addresses of Object.values(networkInterfaces()))
  for (const address of addresses ?? [])
    if (address.family === 'IPv4') console.log(`Open http://${address.address}:${port}/manual`);

let opened = 0;
let open = 0;
setInterval(() => {
  if (fixture.opened() === opened && fixture.open() === open) return;
  opened = fixture.opened();
  open = fixture.open();
  console.log(`${new Date().toISOString()} connections opened ${String(opened)}, open now ${String(open)}`);
}, 100);
