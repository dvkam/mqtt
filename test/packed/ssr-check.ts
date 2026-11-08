import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

export async function checkSsrConsumer(root: string) {
  const fixture = resolve(root, 'ssr');
  mkdirSync(fixture, { recursive: true });
  cpSync(new URL('./ssr-consumer.ts', import.meta.url), resolve(fixture, 'consumer.ts'));
  cpSync(new URL('./ssr-probe.ts', import.meta.url), resolve(fixture, 'probe.ts'));
  for (const mode of ['externalized', 'bundled'] as const) {
    const result = await build({
      root,
      configFile: false,
      logLevel: 'silent',
      ssr: { noExternal: mode === 'bundled' ? ['mqtt'] : [] },
      build: { write: false, ssr: resolve(fixture, 'consumer.ts') },
    });
    const bundles = Array.isArray(result) ? result : [result];
    const chunks = [];
    for (const bundle of bundles) {
      if (!('output' in bundle)) throw new Error('Unexpected SSR watcher');
      for (const entry of bundle.output) {
        if (entry.type === 'chunk') chunks.push(entry);
      }
    }
    assert.equal(chunks.length, 1);
    const chunk = chunks[0];
    assert.ok(chunk !== undefined);
    assert.deepEqual(chunk.dynamicImports, []);
    assert.deepEqual(chunk.imports, mode === 'bundled' ? [] : ['mqtt/browser']);
    assert.doesNotMatch(chunk.code, /__vite-browser-external|\bBuffer\b|\bnode:/);
    const entry = resolve(fixture, mode + '.mjs');
    writeFileSync(entry, chunk.code);
    const run = spawnSync(process.execPath, [resolve(fixture, 'probe.ts'), pathToFileURL(entry).href], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (run.error) throw run.error;
    assert.equal(run.status, 0, run.stdout + run.stderr);
    assert.equal(run.stderr, '');
    assert.equal(run.stdout, JSON.stringify({ connectType: 'function', distinctFactories: true }) + '\n');
    console.log('packed Vite SSR ' + mode + ' import and construction passed');
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2];
  assert.ok(root !== undefined, 'Expected packed consumer directory');
  await checkSsrConsumer(resolve(root));
}
