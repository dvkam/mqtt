import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism, cpus, release } from 'node:os';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runMixedTrafficProbe } from '../experiments/mixed-traffic.ts';
import { observeProbe } from '../experiments/mixed-traffic-metrics.ts';

const packageUrl = new URL('../package.json', import.meta.resolve('mqtt'));
const repositoryRoot = fileURLToPath(new URL('.', packageUrl));
const mode = process.argv[2];
if (mode === undefined) {
  for (let repetition = 1; repetition <= 3; repetition++) {
    const order = repetition % 2 === 1 ? ['tcp', 'websocket'] : ['websocket', 'tcp'];
    for (const transport of order) {
      const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), transport, String(repetition)], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        timeout: 90_000,
        maxBuffer: 1024 * 1024,
      });
      process.stdout.write(child.stdout);
      assert.equal(child.status, 0, child.stderr || String(child.error));
    }
  }
} else {
  assert.ok(typeof globalThis.gc === 'function', 'Run with --expose-gc');
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  const manifest: unknown = JSON.parse(readFileSync(packageUrl, 'utf8'));
  assert.ok(typeof manifest === 'object' && manifest !== null && 'dependencies' in manifest);
  const dependencies = manifest.dependencies;
  assert.ok(typeof dependencies === 'object' && dependencies !== null && 'ws' in dependencies && 'mqtt-packet' in dependencies);
  assert.ok(typeof dependencies.ws === 'string' && typeof dependencies['mqtt-packet'] === 'string');
  const environment = {
    source,
    runtime: process.version,
    platform: process.platform,
    architecture: process.arch,
    kernel: release(),
    cpu: cpus()[0]?.model,
    parallelism: availableParallelism(),
    ws: dependencies.ws,
    mqttPacket: dependencies['mqtt-packet'],
  };
  if (mode === 'gc-calibration') {
    const observation = observeProbe(0);
    globalThis.gc();
    await setImmediate();
    const result = await observation.stop();
    assert.ok(result.gc.count > 0, 'Expected an observed forced GC entry');
    console.log(JSON.stringify({ kind: 'gc-calibration', ...environment, ...result }));
  } else {
    assert.ok(mode === 'tcp' || mode === 'websocket', 'Unknown transport');
    const repetition = Number(process.argv[3]);
    assert.ok(Number.isInteger(repetition) && repetition >= 1 && repetition <= 3, 'Expected repetition 1 through 3');
    globalThis.gc();
    const startedAtUtc = new Date().toISOString();
    const result = await runMixedTrafficProbe({ transport: mode });
    console.log(
      JSON.stringify({
        kind: 'mixed-traffic',
        ...environment,
        repetition,
        startedAtUtc,
        finishedAtUtc: new Date().toISOString(),
        ...result,
      }),
    );
  }
}
