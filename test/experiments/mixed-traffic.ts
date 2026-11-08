import { createTcpClient } from '../../src/tcpClient.js';
import { createWebSocketClient } from '../../src/websocketClient.js';
import type { ClientSession } from '../../src/session.js';
import { ProbeRound, summarizeLatencies, type LatencySummary } from './mixed-traffic-ledger.js';
import { startMixedTrafficPeer } from './mixed-traffic-peer.js';
import { observeProbe } from './mixed-traffic-metrics.js';

export interface MixedTrafficOptions {
  transport: 'tcp' | 'websocket';
  rounds?: number;
  echoDelayMs?: number;
  readPauseMs?: number;
  observerIterations?: number;
  deadlineMs?: number;
  echoFault?: 'duplicate' | 'corrupt' | 'missing';
}
type ProbeMetrics = Awaited<ReturnType<ReturnType<typeof observeProbe>['stop']>>;
export interface MixedTrafficResult extends ProbeMetrics {
  transport: 'tcp' | 'websocket';
  rounds: number;
  burst: number;
  admittedPerRound: number;
  payloadBytes: number;
  echoDelayMs: number;
  readPauseMs: number;
  observerIterations: number;
  elapsedMs: number;
  attempted: number;
  accepted: number;
  rejected: number;
  echoed: number;
  checksum: number;
  workChecksum: number;
  controls: number;
  finalEntries: number;
  entryPeak: number;
  echoPeak: number;
  peerPublications: number;
  peerEchoQueuePeak: number;
  peerEchoQueueFinal: number;
  peerSubscriptions: number;
  peerPings: number;
  sendLatencyMs: LatencySummary;
  echoLatencyMs: LatencySummary;
  controlLatencyMs: LatencySummary;
  observerLatencyMs: LatencySummary;
}
export async function runMixedTrafficProbe(options: Readonly<MixedTrafficOptions>): Promise<MixedTrafficResult> {
  const {
    transport,
    rounds = 1000,
    echoDelayMs = 1,
    readPauseMs = 1,
    observerIterations = 20_000,
    deadlineMs = 60_000,
    echoFault,
  } = options;
  if (
    !Number.isSafeInteger(rounds) ||
    rounds < 1 ||
    rounds > 100_000 ||
    !Number.isSafeInteger(observerIterations) ||
    observerIterations < 0 ||
    observerIterations > 1_000_000 ||
    !Number.isSafeInteger(echoDelayMs) ||
    echoDelayMs < 0 ||
    echoDelayMs > 1000 ||
    !Number.isSafeInteger(readPauseMs) ||
    readPauseMs < 0 ||
    readPauseMs > 1000 ||
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > 2_147_483_647 ||
    !['tcp', 'websocket'].includes(transport)
  )
    throw new Error('Invalid probe configuration');
  const controller = new AbortController();
  let firstFailure: Error | undefined;
  let rejectFailure!: (reason: Readonly<Error>) => void;
  const failed = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  void failed.catch(() => {});
  const fail = (reason: unknown) => {
    if (firstFailure) return;
    firstFailure = reason instanceof Error ? reason : new Error('Probe failure');
    rejectFailure(firstFailure);
    controller.abort(firstFailure);
  };
  const peer = await startMixedTrafficPeer({ transport, echoDelayMs, readPauseMs, echoFault, onFailure: fail });
  const deadline = setTimeout(() => {
    fail(new Error('Probe deadline exceeded'));
  }, deadlineMs);
  const wait = async <Value>(promise: Readonly<Promise<Value>>): Promise<Value> => Promise.race([promise, failed]);
  let client: ClientSession | undefined;
  let observation: ReturnType<typeof observeProbe> | undefined;
  let round: ProbeRound | undefined;
  const sendLatencies: number[] = [];
  const echoLatencies: number[] = [];
  const controlLatencies: number[] = [];
  const observerLatencies: number[] = [];
  let attempted = 0;
  let accepted = 0;
  let rejected = 0;
  let echoed = 0;
  let checksum = 0;
  let entryPeak = 0;
  let echoPeak = 0;
  let workChecksum = 0;
  let finalEntries = 0;
  let completed: MixedTrafficResult | undefined;
  const decoder = new TextDecoder('utf8', { fatal: true });
  const onMessage = (message: unknown) => {
    const entered = performance.now();
    try {
      if (
        typeof message !== 'object' ||
        message === null ||
        !('payload' in message) ||
        !(message.payload instanceof Uint8Array) ||
        !('topic' in message) ||
        message.topic !== 'probe/echo' ||
        !round
      )
        throw new Error('Unexpected probe message');
      const payload = decoder.decode(message.payload);
      let work = 0;
      for (let index = 0; index < observerIterations; index++) work = (work + payload.charCodeAt(index % payload.length)) >>> 0;
      workChecksum = (workChecksum + work) >>> 0;
      round.received(payload, performance.now());
      observerLatencies.push(performance.now() - entered);
    } catch (reason) {
      fail(reason);
    }
  };
  try {
    const factoryOptions = {
      ...peer,
      clientId: 'mixed-probe',
      signal: controller.signal,
      timeoutMs: 3000,
      maxPendingPublishes: 8,
      maxPendingPublishBytes: 4096,
      maxBufferedBytes: 65_536,
      reservedControlBytes: 16_384,
      onMessage,
    };
    client = await wait((transport === 'tcp' ? createTcpClient(factoryOptions) : createWebSocketClient(factoryOptions)).connect());
    await wait(client.subscribe('probe/echo'));
    observation = observeProbe(peer.port);
    const started = performance.now();
    for (let roundIndex = 0; roundIndex < rounds; roundIndex++) {
      const current = new ProbeRound(16, 8);
      round = current;
      const operations: Promise<void>[] = [];
      for (let index = 0; index < 16; index++) {
        const id = roundIndex * 16 + index;
        const payload = current.attempt(id, performance.now());
        operations.push(
          client.publish('probe/echo', payload).then(
            () => {
              current.accepted(id, performance.now());
            },
            (reason: unknown) => {
              if (!(reason instanceof RangeError) || reason.message !== 'MQTT publication capacity exceeded') throw reason;
              current.rejected(id);
            },
          ),
        );
      }
      const controlStart = performance.now();
      const control = ((roundIndex + 1) % 10 === 0 ? client.subscribe('probe/echo') : client.ping()).then(() => {
        controlLatencies.push(performance.now() - controlStart);
      });
      await wait(Promise.all([...operations, control]));
      await wait(current.completion);
      const result = current.finish();
      finalEntries = result.pendingFinal;
      if (finalEntries !== 0) throw new Error('Probe bookkeeping not empty');
      attempted += result.attempted;
      accepted += result.accepted;
      rejected += result.rejected;
      echoed += result.echoed;
      checksum += result.checksum;
      entryPeak = Math.max(entryPeak, result.entryPeak);
      echoPeak = Math.max(echoPeak, result.echoPeak);
      sendLatencies.push(...result.sendLatencies);
      echoLatencies.push(...result.echoLatencies);
    }
    const elapsedMs = performance.now() - started;
    const activeObservation = observation;
    observation = undefined;
    const metrics = await activeObservation.stop();
    await wait(client.disconnect());
    await wait(peer.closed);
    const received = peer.snapshot();
    if (
      received.publications !== accepted ||
      received.checksum !== checksum ||
      received.echoesSent !== echoed ||
      received.echoQueueFinal !== 0 ||
      received.echoQueuePeak > 8 ||
      received.connects !== 1 ||
      received.disconnects !== 1 ||
      received.controlRounds !== rounds ||
      received.subscriptions !== 1 + Math.floor(rounds / 10) ||
      received.pings !== rounds - Math.floor(rounds / 10)
    )
      throw new Error('Probe peer totals mismatch');
    completed = {
      transport,
      rounds,
      burst: 16,
      admittedPerRound: 8,
      payloadBytes: 256,
      echoDelayMs,
      readPauseMs,
      observerIterations,
      elapsedMs,
      attempted,
      accepted,
      rejected,
      echoed,
      checksum,
      workChecksum,
      controls: rounds,
      finalEntries,
      entryPeak,
      echoPeak,
      peerPublications: received.publications,
      peerEchoQueuePeak: received.echoQueuePeak,
      peerEchoQueueFinal: received.echoQueueFinal,
      peerSubscriptions: received.subscriptions,
      peerPings: received.pings,
      sendLatencyMs: summarizeLatencies(sendLatencies),
      echoLatencyMs: summarizeLatencies(echoLatencies),
      controlLatencyMs: summarizeLatencies(controlLatencies),
      observerLatencyMs: summarizeLatencies(observerLatencies),
      ...metrics,
    };
  } catch (reason) {
    fail(reason);
  } finally {
    clearTimeout(deadline);
    const activeObservation = observation;
    observation = undefined;
    if (activeObservation) {
      try {
        await activeObservation.stop();
      } catch (reason) {
        fail(reason);
      }
    }
    if (client) {
      try {
        await client.disconnect();
      } catch (reason) {
        fail(reason);
      }
    }
    try {
      await peer.close();
    } catch (reason) {
      fail(reason);
    }
  }
  if (firstFailure) throw firstFailure;
  if (!completed) throw new Error('Probe result missing');
  return completed;
}
