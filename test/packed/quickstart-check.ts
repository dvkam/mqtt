import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from 'vite';

const consumer = process.argv[2];
assert.ok(consumer !== undefined && consumer !== '', 'Expected a directory with the preview tarball installed');
const root = resolve(consumer);
const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
const duplexRecipe = readFileSync(new URL('../../docs/recipes/using-custom-transports.md', import.meta.url), 'utf8');
const expected = 'Received an echo on example/echo';

function readExample(section: string | undefined, language: string): string {
  const example = section?.split('```' + language + '\n')[1]?.split('\n```')[0];
  assert.ok(example !== undefined && example !== '', 'Missing quickstart example');
  return example + '\n';
}

function readmeSection(heading: string): string | undefined {
  return readme.split('## ' + heading + '\n')[1]?.split('\n## ')[0];
}

writeFileSync(resolve(root, 'echo.mjs'), readExample(readmeSection('Node TCP'), 'js'));
writeFileSync(resolve(root, 'echo-browser.ts'), readExample(readmeSection('Browser WebSocket'), 'ts'));
writeFileSync(resolve(root, 'duplex.ts'), readExample(duplexRecipe, 'ts'));
cpSync(new URL('../../sample/sample.ts', import.meta.url), resolve(root, 'echo-node.ts'));

for (const [file, types, lib] of [
  ['echo-node.ts', ['node'], ['ES2022']],
  ['duplex.ts', ['node'], ['ES2022']],
  ['echo-browser.ts', [], ['ES2022', 'DOM']],
] as const) {
  const config = resolve(root, file + '.json');
  writeFileSync(
    config,
    JSON.stringify({
      compilerOptions: { module: 'NodeNext', target: 'ES2022', types, lib, strict: true, noEmit: true },
      files: [file],
    }),
  );
  const compiler = fileURLToPath(new URL('../../node_modules/typescript-stable/bin/tsc', import.meta.url));
  execFileSync(process.execPath, [compiler, '-p', config], { stdio: 'inherit' });
}

if (!process.argv.includes('--browser-only')) {
  for (const [example, output] of [
    ['echo.mjs', expected],
    ['echo-node.ts', expected],
    ['duplex.ts', 'Broker acknowledged the sensor/reading publication'],
  ] as const) {
    const stdout = execFileSync(process.execPath, [resolve(root, example)], { encoding: 'utf8', timeout: 10000 });
    assert.equal(stdout.trim(), output);
    console.log(example + ' passed');
  }
}

const result = await build({
  root,
  configFile: false,
  logLevel: 'silent',
  build: { write: false, lib: { entry: resolve(root, 'echo-browser.ts'), formats: ['es'] } },
});
const bundles = Array.isArray(result) ? result : [result];
const [bundle] = bundles;
assert.ok(bundles.length === 1 && bundle && 'output' in bundle);
const [chunk] = bundle.output;
assert.equal(bundle.output.length, 1);
assert.deepEqual([...chunk.imports, ...chunk.dynamicImports], []);
assert.doesNotMatch(chunk.code, /__vite-browser-external|\bBuffer\b|\bnode:/u);
console.log('README browser bundle passed');

if (process.argv.includes('--chromium')) {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Write the bundle to the native response on the sample's HTTP origin.
  const server = createServer((request, response) => {
    if (request.url === '/echo.js') response.writeHead(200, { 'Content-Type': 'text/javascript' }).end(chunk.code);
    else response.writeHead(200, { 'Content-Type': 'text/html' }).end('<script type="module" src="/echo.js"></script>');
  });
  server.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address !== null && typeof address !== 'string');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      const echo = page.waitForEvent('console', {
        timeout: 10_000,
        predicate: (message: Readonly<{ text(): string }>) => message.text() === expected,
      });
      await Promise.all([echo, page.goto('http://127.0.0.1:' + address.port)]);
      console.log('README browser echo passed in Chromium ' + browser.version());
    } finally {
      await browser.close();
    }
  } finally {
    server.close();
  }
}
