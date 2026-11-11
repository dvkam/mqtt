import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

const launcher = fileURLToPath(new URL('./packed/mosquitto-container.sh', import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mqtt-container-'));
  const trace = join(root, 'arguments');
  const docker = join(root, 'docker');
  writeFileSync(docker, '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$MQTT_DOCKER_TRACE"\nexit "${MQTT_DOCKER_STATUS:-0}"\n');
  chmodSync(docker, 0o755);
  const environment = { ...process.env, PATH: root + ':' + process.env['PATH'], MQTT_DOCKER_TRACE: trace, MQTT_BROKER_DIR: root };
  return { root, trace, environment };
}

test.runIf(process.platform === 'linux')('the broker launcher pins the image and forwards the mounted config', () => {
  const { root, trace, environment } = fixture();
  try {
    const config = join(root, 'broker config.conf');
    const result = spawnSync('bash', [launcher, '-c', config], { env: environment, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(readFileSync(trace, 'utf8').trimEnd().split('\n')).toEqual([
      'run',
      '--rm',
      '--network',
      'host',
      '--user',
      String(process.getuid?.()) + ':' + String(process.getgid?.()),
      '--mount',
      'type=bind,source=' + root + ',target=' + root + ',readonly',
      'eclipse-mosquitto@sha256:81a6193ae693942a3231cd3ac52875b02b7e3a19da671b2fb4b55cc874c5b279',
      'mosquitto',
      '-c',
      config,
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.runIf(process.platform === 'linux')('the broker launcher preserves the container failure exit code', () => {
  const { root, environment } = fixture();
  try {
    const result = spawnSync('bash', [launcher, '-c', join(root, 'broker.conf')], {
      env: { ...environment, MQTT_DOCKER_STATUS: '23' },
      encoding: 'utf8',
    });
    expect(result.status).toBe(23);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.runIf(process.platform === 'linux')('the broker launcher pulls its pinned image before readiness is checked', () => {
  const { root, trace, environment } = fixture();
  try {
    const result = spawnSync('bash', [launcher, '--pull'], { env: environment, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(readFileSync(trace, 'utf8').trimEnd().split('\n')).toEqual([
      'pull',
      'eclipse-mosquitto@sha256:81a6193ae693942a3231cd3ac52875b02b7e3a19da671b2fb4b55cc874c5b279',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
