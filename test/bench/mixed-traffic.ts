import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { availableParallelism, cpus, release } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runMixedTrafficProbe } from '../experiments/mixed-traffic.ts';
import { observeProbe } from '../experiments/mixed-traffic-metrics.ts';
import { createTcpClient } from 'mqtt';
import { createWebSocketClient } from 'mqtt/ws';

const packageUrl = new URL('../package.json', import.meta.resolve('mqtt'));
const repositoryRoot = fileURLToPath(new URL('.', packageUrl));
const mode = process.argv[2];
const repetitions = Number(process.env['MQTT_MIXED_REPETITIONS'] ?? 3);
assert.ok(Number.isSafeInteger(repetitions) && repetitions > 0, 'Set MQTT_MIXED_REPETITIONS to a positive integer');

function installedVersion(specifier: string): string {
  const manifest: unknown = JSON.parse(readFileSync(new URL(import.meta.resolve(specifier)), 'utf8'));
  assert.ok(typeof manifest === 'object' && manifest !== null && 'version' in manifest && typeof manifest.version === 'string');
  return manifest.version;
}

if (mode === undefined) {
  for (let repetition = 1; repetition <= repetitions; repetition++) {
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
  const source =
    process.env['MQTT_BENCH_REVISION'] ??
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  const environment = {
    source,
    runtime: process.version,
    v8: process.versions.v8,
    platform: process.platform,
    architecture: process.arch,
    kernel: release(),
    cpu: cpus()[0]?.model,
    parallelism: availableParallelism(),
    ws: installedVersion('ws/package.json'),
    mqttPacket: installedVersion('mqtt-packet/package.json'),
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
    assert.ok(Number.isInteger(repetition) && repetition >= 1 && repetition <= repetitions, 'Unexpected repetition number');
    const rounds = Number(process.env['MQTT_MIXED_ROUNDS'] ?? 1000);
    globalThis.gc();
    const startedAtUtc = new Date().toISOString();
    const initialMemory = process.memoryUsage();
    const delay = monitorEventLoopDelay({ resolution: 1 });
    delay.enable();
    const cpuStart = process.cpuUsage();
    let result;
    try {
      result = await runMixedTrafficProbe({ transport: mode, rounds }, { createTcpClient, createWebSocketClient });
    } finally {
      delay.disable();
    }
    const cpu = process.cpuUsage(cpuStart);
    await setImmediate();
    globalThis.gc();
    console.log(
      JSON.stringify({
        kind: 'mixed-traffic',
        ...environment,
        repetition,
        startedAtUtc,
        finishedAtUtc: new Date().toISOString(),
        ...result,
        cpu,
        retained: { initial: initialMemory, afterGc: process.memoryUsage() },
        loopDelayMs: {
          samples: delay.count,
          p50: delay.percentile(50) / 1e6,
          p90: delay.percentile(90) / 1e6,
          p95: delay.percentile(95) / 1e6,
          p99: delay.percentile(99) / 1e6,
          maximum: delay.max / 1e6,
        },
      }),
    );
  }
}
