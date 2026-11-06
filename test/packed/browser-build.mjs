import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build } from 'vite';

const root = resolve(process.argv[2]);
const result = await build({
  root,
  configFile: false,
  logLevel: 'silent',
  build: { write: false, lib: { entry: resolve(root, 'browser.mjs'), formats: ['es'] } },
});
const chunks = result.flatMap(({ output }) => output).filter((entry) => entry.type === 'chunk');
assert.equal(chunks.length, 1);
const [{ code, imports, dynamicImports }] = chunks;
assert.deepEqual([...imports, ...dynamicImports], []);
assert.doesNotMatch(code, /__vite-browser-external|\bBuffer\b|\bnode:/);
console.log(JSON.stringify({ browserBytes: Buffer.byteLength(code), gzipBytes: gzipSync(code).length }));

const engines = process.argv.slice(3);
if (engines.length > 0) {
  const playwright = await import('playwright');
  const server = createServer((request, response) => {
    if (request.url === '/trace.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(code);
    else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    for (const engine of engines) {
      const browser = await playwright[engine].launch();
      try {
        const page = await browser.newPage();
        await page.goto('http://127.0.0.1:' + server.address().port);
        assert.deepEqual(await page.evaluate(async () => (await import('/trace.js')).trace()), {
          packets: ['connect', 'subscribe', 'publish', 'disconnect', 'connect', 'publish'],
          messages: ['hello'],
          outcome: 'closed before drain',
        });
        console.log(engine + ' ' + browser.version() + ' passed');
      } finally {
        await browser.close();
      }
    }
  } finally {
    server.close();
  }
}
