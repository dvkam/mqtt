import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'vitest';
import { createTransportClient } from '../src/portableClient.js';
import { broker } from './experiments/scripted-broker.js';

// Vitest starts its workers without --expose-gc. The flag is on only while a new context reads the collector, so the suite's configuration stays unchanged.
function collector(): () => void {
  setFlagsFromString('--expose-gc');
  const collect: unknown = runInNewContext('gc');
  setFlagsFromString('--no-expose-gc');
  if (typeof collect !== 'function') throw new Error('V8 did not expose its collector');
  return () => {
    Reflect.apply(collect, undefined, []);
  };
}

// The session holds the message handler. Once this function has returned, the test holds neither the session nor the broker.
async function publishAndDrop(): Promise<WeakRef<() => void>> {
  const peer = broker();
  const onMessage = (): void => {};
  const session = await createTransportClient(peer.transport, { clientId: 'idle-timer', timeoutMs: 60_000, onMessage }).connect();
  await session.publish('idle/timer', 'payload');
  expect(peer.received(0).commands).toEqual(['connect', 'publish']);
  return new WeakRef(onMessage);
}

test('a session that nothing references is collected while its idle QoS 0 deadline timer is pending', async () => {
  const collect = collector();
  const handler = await publishAndDrop();
  for (let attempt = 0; attempt < 10 && handler.deref() !== undefined; attempt++) {
    // A WeakRef keeps its target until the current job ends, so each attempt collects in a new one.
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    collect();
  }
  expect(handler.deref()).toBeUndefined();
});
