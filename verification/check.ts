import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const jarPath = resolve(process.env['TLC_JAR'] ?? 'tla2tools.jar');
assert.equal(
  createHash('sha1').update(readFileSync(jarPath)).digest('hex'),
  'bee4a54f3ee3d4afc347c3240ec2d9e93b075104',
  'Use the published TLC 1.7.4 jar',
);

type VerificationCase = readonly [model: string, configuration: string, expectedInvariant?: string];

const models: readonly VerificationCase[] = [
  ['PingFence', 'PingFence'],
  ['PingFence', 'PingFenceBroken', 'NoWrongReply'],
  ['PingFence', 'PingFenceRetry', 'NoSendAfterFailure'],
  ['WebSocketOpen', 'WebSocketOpen'],
  ['WebSocketOpen', 'WebSocketOpenBroken', 'TerminalOwnership'],
  ['WebSocketSession', 'WebSocketSession'],
  ['WebSocketSession', 'WebSocketSessionDeliver', 'NoInvalidDelivery'],
  ['WebSocketSession', 'WebSocketSessionBudget', 'BoundedBudget'],
  ['BrowserTransport', 'BrowserTransport'],
  ['BrowserTransport', 'BrowserTransportDelivery', 'NoLateDelivery'],
  ['BrowserTransport', 'BrowserTransportBudget', 'BoundedAdmission'],
  ['BrowserTransport', 'BrowserTransportObserver', 'NativeCloseSettles'],
  ['CodecFrames', 'CodecFrames'],
  ['CodecFrames', 'CodecFramesAllocation', 'BoundedAllocation'],
  ['CodecFrames', 'CodecFramesEarly', 'CompleteBeforeEmit'],
  ['CodecFrames', 'CodecFramesPoison', 'NoOutputAfterFailure'],
  ['CodecEndOfInput', 'CodecEndOfInput'],
  ['CodecEndOfInput', 'CodecEndOfInputTruncated', 'RejectTruncatedEnd'],
  ['CodecEndOfInput', 'CodecEndOfInputOutput', 'NoOutputAfterEnd'],
  ['CodecEndOfInput', 'CodecEndOfInputFailure', 'PreserveFailure'],
  ['BrowserClientHandoff', 'BrowserClientHandoff'],
  ['BrowserClientHandoff', 'BrowserClientHandoffAbort', 'NoCancelledTransfer'],
  ['BrowserClientHandoff', 'BrowserClientHandoffForce', 'ForceWithoutNativeWait'],
];

for (const [model, configuration, expectedInvariant] of models) {
  const metadataDirectory = mkdtempSync(join(tmpdir(), 'mqtt-tlc-'));
  try {
    const run = spawnSync(
      process.env['JAVA'] ?? 'java',
      [
        '-cp',
        jarPath,
        'tlc2.TLC',
        '-workers',
        '1',
        '-metadir',
        metadataDirectory,
        '-config',
        configuration + '.cfg',
        model + '.tla',
      ],
      { cwd: fileURLToPath(new URL('./', import.meta.url)), encoding: 'utf8' },
    );
    if (run.error) throw run.error;
    const output = run.stdout + run.stderr;
    if (expectedInvariant !== undefined) {
      assert.notEqual(run.status, 0, output);
      assert.match(output, new RegExp('Invariant ' + expectedInvariant + ' is violated'), output);
      console.log(configuration + ' caught ' + expectedInvariant);
    } else {
      assert.equal(run.status, 0, output);
      assert.match(output, /No error has been found/, output);
      console.log(configuration + ' ' + /\d+ distinct states found/.exec(output)?.[0]);
    }
  } finally {
    rmSync(metadataDirectory, { recursive: true, force: true });
  }
}
