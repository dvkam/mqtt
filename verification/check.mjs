import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const jar = resolve(process.env.TLC_JAR ?? 'tla2tools.jar');
assert.equal(
  createHash('sha1').update(readFileSync(jar)).digest('hex'),
  'bee4a54f3ee3d4afc347c3240ec2d9e93b075104',
  'Use the published TLC 1.7.4 jar',
);

const models = [
  ['PingFence', 'PingFence'],
  ['PingFence', 'PingFenceBroken', 'NoWrongReply'],
  ['PingFence', 'PingFenceRetry', 'NoSendAfterFailure'],
  ['WebSocketOpen', 'WebSocketOpen'],
  ['WebSocketOpen', 'WebSocketOpenBroken', 'TerminalOwnership'],
];

for (const [model, config, invariant] of models) {
  const metadir = mkdtempSync(join(tmpdir(), 'mqtt-tlc-'));
  try {
    const run = spawnSync(
      process.env.JAVA ?? 'java',
      ['-cp', jar, 'tlc2.TLC', '-workers', '1', '-metadir', metadir, '-config', config + '.cfg', model + '.tla'],
      { cwd: fileURLToPath(new URL('./', import.meta.url)), encoding: 'utf8' },
    );
    if (run.error) throw run.error;
    const output = run.stdout + run.stderr;
    if (invariant) {
      assert.notEqual(run.status, 0, output);
      assert.match(output, new RegExp('Invariant ' + invariant + ' is violated'), output);
      console.log(config + ' caught ' + invariant);
    } else {
      assert.equal(run.status, 0, output);
      assert.match(output, /No error has been found/, output);
      console.log(config + ' ' + output.match(/\d+ distinct states found/)?.[0]);
    }
  } finally {
    rmSync(metadir, { recursive: true, force: true });
  }
}
