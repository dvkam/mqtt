import assert from 'node:assert/strict';

for (const name of ['WebSocket', 'window', 'document', 'navigator']) {
  assert.equal(Reflect.deleteProperty(globalThis, name), true);
}
Object.defineProperty(globalThis, 'fetch', {
  value() {
    throw new Error('SSR attempted network I/O before connect');
  },
});

const entry = process.argv[2];
assert.ok(entry !== undefined, 'Expected SSR entry URL');
const loaded: unknown = await import(entry);

function hasInspector(value: unknown): value is { inspectFactory: () => unknown } {
  return typeof value === 'object' && value !== null && 'inspectFactory' in value && typeof value.inspectFactory === 'function';
}
assert.ok(hasInspector(loaded), 'Expected the SSR factory inspector');
const result = loaded.inspectFactory();
assert.deepEqual(result, { connectType: 'function', distinctFactories: true });
console.log(JSON.stringify(result));
