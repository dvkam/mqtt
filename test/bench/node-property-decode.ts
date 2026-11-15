// Decode throughput of the supported Node decoder for packets with and without properties.
// Run after pnpm build: node --expose-gc test/bench/node-property-decode.ts
import { availableParallelism, cpus, release } from 'node:os';
import { generate, type Packet } from 'mqtt-packet';
import { NodePacketDecoder } from '../../dist/nodePacketDecoder.js';

const userProperties = { region: 'eu', tenant: 'a'.repeat(32), tag: ['x', 'y', 'z'] };
const workloads: [string, Packet][] = [
  [
    'PUBLISH without properties',
    { cmd: 'publish', topic: 'sensor/7', payload: Buffer.alloc(256, 97), qos: 0, dup: false, retain: false },
  ],
  [
    'PUBLISH with publisher properties',
    {
      cmd: 'publish',
      topic: 'sensor/7',
      payload: Buffer.alloc(256, 97),
      qos: 1,
      messageId: 7,
      dup: false,
      retain: false,
      properties: {
        payloadFormatIndicator: true,
        messageExpiryInterval: 60,
        contentType: 'application/json',
        responseTopic: 'reply/sensor/7',
        correlationData: Buffer.alloc(16, 1),
        userProperties,
      },
    },
  ],
  [
    // Every string here leaves the ASCII fast path: non-ASCII text, or more than 64 bytes.
    'PUBLISH with non-ASCII and long property strings',
    {
      cmd: 'publish',
      topic: 'sensor/7',
      payload: Buffer.alloc(256, 97),
      qos: 0,
      dup: false,
      retain: false,
      properties: {
        contentType: 'text/plain; charset=ü',
        responseTopic: 'reply/' + 'segment/'.repeat(10),
        userProperties: { schlüssel: 'wert-ä', description: 'd'.repeat(100) },
      },
    },
  ],
  [
    'CONNACK with every broker property',
    {
      cmd: 'connack',
      sessionPresent: false,
      reasonCode: 0,
      properties: {
        sessionExpiryInterval: 3600,
        receiveMaximum: 20,
        maximumQoS: 1,
        retainAvailable: true,
        maximumPacketSize: 65_536,
        assignedClientIdentifier: 'client-assigned-0001',
        topicAliasMaximum: 10,
        reasonString: 'accepted',
        userProperties,
        wildcardSubscriptionAvailable: true,
        subscriptionIdentifiersAvailable: true,
        sharedSubscriptionAvailable: true,
        serverKeepAlive: 60,
        responseInformation: 'reply/',
        serverReference: 'broker-2',
      },
    },
  ],
];

const packetsPerBatch = 2000;
const batches = 40;
const warmupBatches = 10;
let sink = 0;

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The decoder reads native mutable byte views.
function run(wire: Readonly<Uint8Array>): number {
  const decoder = new NodePacketDecoder({
    maxPacketBytes: wire.length,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Decoded packets carry mutable byte views.
    onPacket(packet) {
      sink += packet.cmd.length;
    },
  });
  const started = performance.now();
  for (let index = 0; index < packetsPerBatch; index++) decoder.push(wire);
  return performance.now() - started;
}

console.log(
  JSON.stringify({
    kind: 'environment',
    runtime: process.version,
    kernel: release(),
    parallelism: availableParallelism(),
    cpu: cpus()[0]?.model,
  }),
);
for (const [name, packet] of workloads) {
  const wire = Uint8Array.from(generate(packet, { protocolVersion: 5 }));
  for (let index = 0; index < warmupBatches; index++) run(wire);
  const times: number[] = [];
  for (let index = 0; index < batches; index++) {
    globalThis.gc?.();
    times.push(run(wire));
  }
  times.sort((left, right) => left - right);
  const median = times[Math.floor(times.length / 2)]!;
  console.log(
    JSON.stringify({
      kind: 'decode',
      workload: name,
      bytes: wire.length,
      packetsPerBatch,
      medianMs: Number(median.toFixed(3)),
      packetsPerSecond: Math.round((packetsPerBatch / median) * 1000),
    }),
  );
}
if (sink === 0) throw new Error('No packets decoded');
