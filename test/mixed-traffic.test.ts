import { expect, test } from 'vitest';
import { probePayload, ProbeRound, summarizeLatencies } from './experiments/mixed-traffic-ledger.js';
import { runMixedTrafficProbe } from './experiments/mixed-traffic.js';

test('latency summaries use nearest-rank successful samples', () => {
  const samples = Array.from({ length: 100 }, (_, index) => 100 - index);
  expect(summarizeLatencies(samples)).toEqual({ count: 100, minimum: 1, p50: 50, p99: 99, maximum: 100 });
  expect(samples[0]).toBe(100);
});
test.each([{ samples: [] }, { samples: [NaN] }, { samples: [-1] }, { samples: [Infinity] }])(
  'rejects invalid latency observations %j',
  ({ samples }: Readonly<{ samples: readonly number[] }>) => {
    expect(() => summarizeLatencies(samples)).toThrow('Invalid latency samples');
  },
);
test('round ledger validates exact echoes, outcomes and final zero bookkeeping', () => {
  const round = new ProbeRound(2, 1);
  expect(round.attempt(16, 10)).toBe(probePayload(16));
  round.attempt(17, 11);
  round.accepted(16, 12);
  round.rejected(17);
  round.received(probePayload(16), 20);
  expect(round.finish()).toEqual({
    attempted: 2,
    accepted: 1,
    rejected: 1,
    echoed: 1,
    checksum: 16,
    entryPeak: 2,
    echoPeak: 1,
    pendingFinal: 0,
    sendLatencies: [2],
    echoLatencies: [10],
  });
});
test.each(['duplicate', 'corrupt', 'rejected', 'missing'] as const)('detects %s echo failure', (fault) => {
  const round = new ProbeRound(2, 1);
  round.attempt(16, 0);
  round.attempt(17, 0);
  round.accepted(16, 1);
  round.rejected(17);
  const action = () => {
    switch (fault) {
      case 'missing':
        round.finish();
        break;
      case 'corrupt':
        round.received(probePayload(16).slice(0, -1) + 'y', 2);
        break;
      case 'rejected':
        round.received(probePayload(17), 2);
        break;
      case 'duplicate':
        round.received(probePayload(16), 2);
        round.received(probePayload(16), 3);
        break;
    }
  };
  expect(action).toThrow(fault === 'missing' ? 'Missing or unsettled probe traffic' : 'Unexpected probe payload');
});

test.each(['tcp', 'websocket'] as const)('%s mixed probe admits bounded bursts and completes control work', async (transport) => {
  const result = await runMixedTrafficProbe({ transport, rounds: 10, echoDelayMs: 0, readPauseMs: 0, observerIterations: 32 });
  expect(result).toMatchObject({
    attempted: 160,
    accepted: 80,
    rejected: 80,
    echoed: 80,
    controls: 10,
    finalEntries: 0,
    peerPublications: 80,
    peerEchoQueueFinal: 0,
    workChecksum: 261796,
    checksum: 6040,
  });
});
test.each(['duplicate', 'corrupt', 'missing'] as const)('mixed probe rejects %s echoes and tears down', async (echoFault) => {
  await expect(
    runMixedTrafficProbe({
      transport: 'tcp',
      rounds: 1,
      echoDelayMs: 0,
      readPauseMs: 0,
      observerIterations: 0,
      deadlineMs: 1000,
      echoFault,
    }),
  ).rejects.toThrow(echoFault === 'missing' ? 'Probe deadline' : 'Unexpected probe payload');
});
