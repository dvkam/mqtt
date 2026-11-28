import { crc32 } from 'node:zlib';
import { expect, test } from 'vitest';
import { encodePacket } from '../src/codec.js';
import {
  compactionDue,
  compactionThreshold,
  emptyJournalState,
  encodeFrame,
  encodeSegmentStart,
  frameBytes,
  frameHeaderBytes,
  journalFormatVersion,
  readSegment,
  recordBytes,
  recoverSegment,
  segmentBytesBound,
  segmentPrefix,
  segmentPrefixBytes,
  snapshotRecords,
  type JournalRecord,
  type JournalState,
  type SegmentOwner,
  type SegmentRecovery,
} from '../src/journalFormat.js';
import { capturePublication } from '../src/publication.js';
import { publishSize } from '../src/publicationAdmission.js';
import type { ReadonlyBytes } from '../src/util/bytes.js';
import { utf8Length } from '../src/util/utf8.js';
import {
  below,
  canonical,
  generateSegment,
  joined,
  random,
  rawFrame,
  rawRecord,
  type GeneratedSegment,
} from './experiments/journal-segments.js';

const generation = 7;
const owner: SegmentOwner = { processId: 4242, uptime: 360, host: 'sensor-7', token: 'c0ffee' };
const empty = emptyJournalState('sensor-7', 'mqtts://broker.example:8883');
const time = 1_764_000_000_000;

function qosTwo(topic: string, payload: string) {
  return { ...capturePublication(topic, payload, undefined, true, 1_000_000, 1_000_000, 2), qos: 2 as const };
}

/** A segment of the snapshot of `state` and one frame for each list of records, all in the epoch of `state`. */
function segment(state: JournalState, ...batches: readonly (readonly JournalRecord[])[]): Uint8Array<ArrayBuffer> {
  return joined(
    encodeSegmentStart(generation, owner, state, time),
    ...batches.map((records, index) =>
      encodeFrame({ generation, batch: index + 2, epoch: state.epoch, time: time + index + 1, records }),
    ),
  );
}

function recovered(bytes: ReadonlyBytes): Extract<SegmentRecovery, { outcome: 'recovered' }> {
  const result = recoverSegment(bytes, generation);
  if (result.outcome !== 'recovered') throw new Error('Expected a recovered segment, got ' + JSON.stringify(result));
  return result;
}

test('a frame has the documented bytes', () => {
  const frame = encodeFrame({
    generation,
    batch: 2,
    epoch: 3,
    time: 0x01_0203_0405,
    records: [{ kind: 'delivered', messageId: 0x1234 }],
  });
  expect([...frame]).toEqual([
    ...[0x4d, 0x51, 0x4a, 0x46], // The ASCII text MQJF.
    ...[0, 0, 0, 7], // The length of the records.
    ...[0x19, 0x86, 0x26, 0xfa], // The CRC-32 of every byte after it.
    ...[0, 0, 0, 0, 0, 0, 0, 7], // The generation.
    ...[0, 0, 0, 2], // The batch number.
    ...[0, 0, 0, 3], // The epoch.
    ...[0, 0, 0, 1, 2, 3, 4, 5], // The time.
    ...[7, 0, 0, 0, 2, 0x12, 0x34], // One record: type 7 for delivered, a body of 2 bytes, the Packet Identifier.
  ]);
  expect(crc32('123456789')).toBe(0xcbf4_3926);
  expect(frame).toEqual(rawFrame(generation, 2, 3, 0x01_0203_0405, rawRecord(7, [0x12, 0x34])));
  expect([...segmentPrefix()]).toEqual([0x4d, 0x51, 0x54, 0x54, 0x4a, 0x4e, 0x4c, journalFormatVersion]);
  expect(segmentPrefix()).toHaveLength(segmentPrefixBytes);
});

test('a publication is stored as the PUBLISH packet the encoder writes', () => {
  const captured = capturePublication(
    'orders/created',
    Uint8Array.of(1, 2, 3),
    { retain: true, contentType: 'x', correlationData: Uint8Array.of(9) },
    true,
    1000,
    1000,
    2,
  );
  const publication = { ...captured, qos: 2 as const };
  const frame = encodeFrame({
    generation,
    batch: 2,
    epoch: 0,
    time,
    records: [{ kind: 'publication', sequence: 5, messageId: 258, publication }],
  });
  const packet = encodePacket({
    cmd: 'publish',
    topic: 'orders/created',
    payload: Uint8Array.of(1, 2, 3),
    qos: 2,
    messageId: 258,
    dup: false,
    retain: true,
    contentType: 'x',
    correlationData: Uint8Array.of(9),
  });
  expect(frame.subarray(frameHeaderBytes + 5 + 8)).toEqual(packet);
  expect([...frame.subarray(frameHeaderBytes, frameHeaderBytes + 13)]).toEqual([
    2,
    0,
    0,
    0,
    8 + packet.length,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    5,
  ]);
});

test('a recovered publication has the fields and byte counts the session resume code compares with the broker limits', () => {
  const next = random(11);
  const stored = Array.from({ length: 40 }, (_, index) => {
    const options = {
      ...(index % 2 === 0 ? {} : { retain: true, contentType: 'text/' + String(index) }),
      ...(index % 3 === 0 ? { userProperties: [['a', 'ä'.repeat(index)] as const], messageExpiryInterval: index } : {}),
      ...(index % 5 === 0
        ? { correlationData: Uint8Array.from({ length: index }, () => below(next, 256)), responseTopic: 'r' }
        : {}),
    };
    const qos: 1 | 2 = index % 4 === 0 ? 2 : 1;
    // Sizes on both sides of the one-byte and two-byte Remaining Length.
    const payload = Uint8Array.from({ length: index * 9 }, () => below(next, 256));
    const captured = capturePublication('topic/' + 'µ'.repeat(index), payload, options, true, 1_000_000, 1_000_000, qos);
    return { sequence: index, messageId: index + 1, publication: qos === 2 ? { ...captured, qos } : captured };
  });
  const state: JournalState = { ...empty, nextSequence: 40, publications: stored };
  const start = encodeSegmentStart(generation, owner, state, time);
  const { publications } = recovered(start).state;
  expect(publications).toEqual(stored);
  for (const { messageId, publication } of publications) {
    const { topic, payloadBytes, propertyBytes, qos = 1 } = publication;
    const packet = encodePacket({
      cmd: 'publish',
      topic,
      payload: publication.payload,
      qos,
      messageId,
      dup: false,
      retain: publication.retain,
      ...publication.properties,
    });
    expect(publishSize(utf8Length(topic), payloadBytes, propertyBytes, qos)).toBe(packet.length);
  }
});

test('every record kind survives a frame, and each has the size recordBytes gives', () => {
  const publication = qosTwo('a/b', 'payload');
  const records: JournalRecord[] = [
    { kind: 'segment', owner, clientId: 'sensor-7', broker: 'b', epoch: 2, established: true, nextSequence: 9 },
    { kind: 'publication', sequence: 3, messageId: 4, publication },
    { kind: 'acknowledged', messageId: 1 },
    { kind: 'received', messageId: 2 },
    { kind: 'completed', messageId: 3 },
    { kind: 'withdrawn', messageId: 4 },
    { kind: 'delivered', messageId: 5 },
    { kind: 'released', messageId: 65_535 },
    { kind: 'releasing', messageId: 6, topic: 'größe' },
    { kind: 'epoch', epoch: 3, established: false },
    { kind: 'connected', sessionExpiryInterval: 4_294_967_295 },
    { kind: 'ended', time: Number.MAX_SAFE_INTEGER },
    { kind: 'fact', requestedQos: 2, grantedQos: 1, subscribed: true },
    { kind: 'closed' },
  ];
  const frame = encodeFrame({ generation, batch: 1, epoch: 2, time, records });
  expect(frame).toHaveLength(frameBytes(records));
  expect(frameBytes(records)).toBe(frameHeaderBytes + records.reduce((size, record) => size + recordBytes(record), 0));
  const read = readSegment(joined(segmentPrefix(), frame), generation);
  expect(read).toEqual({
    outcome: 'read',
    frames: [{ generation, batch: 1, epoch: 2, time, records }],
    offsets: [8],
    tail: 'clean',
    bytes: 8 + frame.length,
  });
});

test('the encoder refuses values the format cannot hold', () => {
  const frame = (records: readonly JournalRecord[]) => encodeFrame({ generation, batch: 2, epoch: 0, time, records });
  expect(() => frame([{ kind: 'delivered', messageId: 0 }])).toThrow(RangeError);
  expect(() => frame([{ kind: 'delivered', messageId: 65_536 }])).toThrow(RangeError);
  expect(() => frame([{ kind: 'releasing', messageId: 1, topic: 'a\u0000' }])).toThrow(RangeError);
  expect(() => frame([{ kind: 'releasing', messageId: 1, topic: 'x'.repeat(65_536) }])).toThrow(RangeError);
  expect(() => frame([{ kind: 'epoch', epoch: -1, established: true }])).toThrow(RangeError);
  expect(() => frame([{ kind: 'ended', time: 2 ** 53 }])).toThrow(RangeError);
  expect(() => encodeFrame({ generation: 1.5, batch: 2, epoch: 0, time, records: [] })).toThrow(RangeError);
  const publication = { ...qosTwo('a', 'b'), payloadBytes: 9 };
  expect(() => frame([{ kind: 'publication', sequence: 0, messageId: 1, publication }])).toThrow(RangeError);
  expect(() => readSegment(segmentPrefix(), -1)).toThrow(RangeError);
});

test('a snapshot of a state recovers to that state, and a snapshot of a recovered state equals the history', () => {
  const publication = qosTwo('a/b', 'payload');
  const state: JournalState = {
    clientId: 'sensor-7',
    broker: 'mqtts://broker.example:8883',
    epoch: 4,
    established: true,
    nextSequence: 12,
    publications: [
      { sequence: 3, messageId: 9, publication },
      { sequence: 8, messageId: 2, publication: capturePublication('q1', 'x', undefined, true, 100, 100, 1) },
    ],
    releases: [
      { messageId: 7, topic: 'released/first' },
      { messageId: 1, topic: 'released/second' },
    ],
    delivered: [5, 3],
    requestedQos: 2,
    grantedQos: 1,
    subscribed: true,
    connection: { sessionExpiryInterval: 3600, endedAt: time - 5 },
    closed: false,
  };
  const start = encodeSegmentStart(generation, owner, state, time);
  expect(recoverSegment(start, generation)).toEqual({
    outcome: 'recovered',
    owner,
    state,
    batches: 1,
    time,
    tail: 'clean',
    bytes: start.length,
  });
  expect(recovered(encodeSegmentStart(generation, owner, empty, time)).state).toEqual(empty);
  expect(recovered(encodeSegmentStart(generation, owner, { ...empty, closed: true }, time)).state).toEqual({
    ...empty,
    closed: true,
  });
  const next = random(3);
  for (let round = 0; round < 20; round++) {
    const generated = generateSegment(next, 6);
    const end = recoverSegment(generated.bytes, generated.generation);
    if (end.outcome !== 'recovered') throw new Error('Expected a recovered segment');
    const compacted = encodeSegmentStart(generated.generation + 1, generated.owner, end.state, time);
    expect(canonical(recoverSegment(compacted, generated.generation + 1))).toBe(
      canonical({ ...end, batches: 1, time, bytes: compacted.length }),
    );
  }
});

test('records change the state as documented', () => {
  const second = qosTwo('second', '2');
  const first = capturePublication('first', '1', undefined, true, 100, 100, 1);
  const bytes = segment(
    empty,
    [
      { kind: 'connected', sessionExpiryInterval: 60 },
      { kind: 'publication', sequence: 0, messageId: 1, publication: first },
      { kind: 'publication', sequence: 1, messageId: 2, publication: second },
      { kind: 'publication', sequence: 2, messageId: 3, publication: second },
      { kind: 'delivered', messageId: 1 },
      { kind: 'delivered', messageId: 9 },
    ],
    [],
    [
      { kind: 'received', messageId: 3 },
      { kind: 'received', messageId: 2 },
      { kind: 'acknowledged', messageId: 1 },
      { kind: 'released', messageId: 1 },
      { kind: 'fact', requestedQos: 2, grantedQos: 2, subscribed: true },
      { kind: 'publication', sequence: 3, messageId: 1, publication: first },
      { kind: 'ended', time: time + 2 },
    ],
  );
  expect(recovered(bytes)).toMatchObject({
    batches: 4,
    time: time + 3,
    state: {
      ...empty,
      established: true,
      nextSequence: 4,
      publications: [{ sequence: 3, messageId: 1, publication: first }],
      releases: [
        { messageId: 3, topic: 'second' },
        { messageId: 2, topic: 'second' },
      ],
      delivered: [9],
      requestedQos: 2,
      grantedQos: 2,
      subscribed: true,
      connection: { sessionExpiryInterval: 60, endedAt: time + 2 },
    },
  });
  const later = joined(
    bytes,
    encodeFrame({
      generation,
      batch: 5,
      epoch: 0,
      time: time + 9,
      records: [
        { kind: 'completed', messageId: 3 },
        { kind: 'epoch', epoch: 1, established: true },
        { kind: 'delivered', messageId: 4 },
      ],
    }),
    encodeFrame({ generation, batch: 6, epoch: 1, time: time + 10, records: [] }),
    encodeFrame({ generation, batch: 7, epoch: 1, time: time + 11, records: [{ kind: 'closed' }] }),
  );
  expect(recovered(later).state).toEqual({ ...empty, epoch: 1, established: true, nextSequence: 4, delivered: [4], closed: true });
});

test('a torn tail is dropped', () => {
  const batches: JournalRecord[][] = [[{ kind: 'delivered', messageId: 1 }], [{ kind: 'delivered', messageId: 2 }]];
  const bytes = segment(empty, ...batches);
  const whole = recovered(bytes);
  expect(whole).toMatchObject({ tail: 'clean', batches: 3, bytes: bytes.length, state: { delivered: [1, 2] } });
  const secondFrame = bytes.length - frameBytes(batches[1] ?? []);
  for (const cut of [secondFrame + 1, secondFrame + frameHeaderBytes, bytes.length - 1])
    expect(recovered(bytes.subarray(0, cut))).toMatchObject({
      tail: 'torn',
      batches: 2,
      bytes: secondFrame,
      time: time + 1,
      state: { delivered: [1] },
    });
  expect(recovered(bytes.subarray(0, secondFrame))).toMatchObject({ tail: 'clean', batches: 2, bytes: secondFrame });
  const damaged = Uint8Array.from(bytes);
  damaged[bytes.length - 1] = (damaged[bytes.length - 1] ?? 0) ^ 1;
  expect(recovered(damaged)).toMatchObject({ tail: 'torn', batches: 2, state: { delivered: [1] } });
  expect(recovered(joined(bytes, new Uint8Array(4096)))).toMatchObject({ tail: 'torn', batches: 3, bytes: bytes.length });
});

test('a segment without a valid snapshot is incomplete', () => {
  const start = encodeSegmentStart(generation, owner, empty, time);
  expect(recoverSegment(new Uint8Array(), generation)).toEqual({ outcome: 'incomplete' });
  expect(recoverSegment(segmentPrefix(), generation)).toEqual({ outcome: 'incomplete' });
  expect(recoverSegment(start.subarray(0, 5), generation)).toEqual({ outcome: 'incomplete' });
  expect(recoverSegment(start.subarray(0, start.length - 1), generation)).toEqual({ outcome: 'incomplete' });
  expect(recoverSegment(new Uint8Array(4096), generation)).toEqual({ outcome: 'incomplete' });
  expect(readSegment(start.subarray(0, start.length - 1), generation)).toEqual({ outcome: 'incomplete' });
});

test('a damaged frame before a valid frame makes the segment unreadable', () => {
  const batches: JournalRecord[][] = [[{ kind: 'delivered', messageId: 1 }], [{ kind: 'delivered', messageId: 2 }]];
  const bytes = segment(empty, ...batches);
  const secondFrame = bytes.length - frameBytes(batches[1] ?? []);
  const firstFrame = secondFrame - frameBytes(batches[0] ?? []);
  const flipped = (offset: number) => {
    const damaged = Uint8Array.from(bytes);
    damaged[offset] = (damaged[offset] ?? 0) ^ 0x10;
    return recoverSegment(damaged, generation);
  };
  expect(flipped(firstFrame + frameHeaderBytes)).toMatchObject({ outcome: 'unreadable', reason: 'damaged', offset: firstFrame });
  expect(flipped(firstFrame + 5)).toMatchObject({ outcome: 'unreadable', reason: 'damaged', offset: firstFrame });
  expect(flipped(segmentPrefixBytes + 20)).toMatchObject({ outcome: 'unreadable', reason: 'damaged', offset: segmentPrefixBytes });
  expect(flipped(2)).toMatchObject({ outcome: 'unreadable', reason: 'damaged', offset: 0 });
  // A frame that is missing: the frame after it has a batch number above the expected one.
  expect(recoverSegment(joined(bytes.subarray(0, firstFrame), bytes.subarray(secondFrame)), generation)).toMatchObject({
    outcome: 'unreadable',
    reason: 'damaged',
    offset: firstFrame,
  });
  // The same frame twice: the second copy does not continue the batch numbers and nothing valid follows it.
  expect(recovered(joined(bytes, bytes.subarray(secondFrame)))).toMatchObject({ tail: 'torn', batches: 3, bytes: bytes.length });
});

test('frames of another generation in the tail are not taken for frames of the segment', () => {
  const bytes = segment(empty, [{ kind: 'delivered', messageId: 1 }]);
  const stale = joined(
    encodeFrame({ generation: generation - 1, batch: 3, epoch: 0, time, records: [{ kind: 'delivered', messageId: 2 }] }),
    encodeFrame({ generation: generation - 1, batch: 9, epoch: 0, time, records: [] }),
  );
  expect(recovered(joined(bytes, stale))).toMatchObject({
    tail: 'torn',
    batches: 2,
    bytes: bytes.length,
    state: { delivered: [1] },
  });
  expect(recoverSegment(bytes, generation + 1)).toEqual({ outcome: 'incomplete' });
  expect(recoverSegment(bytes, generation + 2 ** 32)).toEqual({ outcome: 'incomplete' });
});

test('an unknown format version makes the segment unreadable', () => {
  const bytes = segment(empty, [{ kind: 'delivered', messageId: 1 }]);
  for (const version of [0, 2, 255]) {
    const other = Uint8Array.from(bytes);
    other[segmentPrefixBytes - 1] = version;
    expect(recoverSegment(other, generation)).toMatchObject({ outcome: 'unreadable', reason: 'version', offset: 0 });
    expect(recoverSegment(other.subarray(0, segmentPrefixBytes), generation)).toMatchObject({
      outcome: 'unreadable',
      reason: 'version',
    });
  }
});

test('an unknown or malformed record makes the segment unreadable', () => {
  const start = encodeSegmentStart(generation, owner, empty, time);
  const withRecords = (...records: readonly ReadonlyBytes[]) =>
    recoverSegment(joined(start, rawFrame(generation, 2, 0, time, joined(...records))), generation);
  expect(withRecords(rawRecord(7, [0, 1]))).toMatchObject({ outcome: 'recovered', state: { delivered: [1] } });
  for (const records of [
    [rawRecord(0)],
    [rawRecord(15)],
    [rawRecord(255, [1, 2, 3])],
    // A body that is longer or shorter than the fields of its type.
    [rawRecord(7, [0, 1, 0])],
    [rawRecord(7, [0])],
    [rawRecord(14, [0])],
    // A length that reaches past the frame.
    [Uint8Array.of(7, 0, 0, 0, 9, 0, 1)],
    [Uint8Array.of(7, 0, 0)],
    // Field values outside their range.
    [rawRecord(7, [0, 0])],
    [rawRecord(13, [3, 0, 0])],
    [rawRecord(13, [0, 0, 2])],
    [rawRecord(10, [0, 0, 0, 1, 2])],
    [rawRecord(12, [0, 0x20, 0, 0, 0, 0, 0, 0])],
    [rawRecord(9, [0, 1, 0, 1, 0xff])],
    [rawRecord(9, [0, 1, 0, 1, 0])],
  ])
    expect(withRecords(...records)).toMatchObject({ outcome: 'unreadable', reason: 'record', offset: start.length });
  expect(recoverSegment(joined(start, rawFrame(generation, 2, 0, 2 ** 53, new Uint8Array())), generation)).toMatchObject({
    outcome: 'unreadable',
    reason: 'record',
  });
});

test('a stored packet that is not a first PUBLISH of the session makes the segment unreadable', () => {
  const start = encodeSegmentStart(generation, owner, empty, time);
  const withPacket = (packet: ReadonlyBytes) =>
    recoverSegment(joined(start, rawFrame(generation, 2, 0, time, rawRecord(2, joined(new Uint8Array(8), packet)))), generation);
  const packet = encodePacket({
    cmd: 'publish',
    topic: 'a',
    payload: Uint8Array.of(1),
    qos: 1,
    messageId: 1,
    dup: false,
    retain: false,
  });
  expect(withPacket(packet)).toMatchObject({ outcome: 'recovered', state: { publications: [{ sequence: 0, messageId: 1 }] } });
  const changed = (index: number, value: number) => {
    const copy = Uint8Array.from(packet);
    copy[index] = value;
    return copy;
  };
  for (const stored of [
    new Uint8Array(),
    encodePacket({ cmd: 'publish', topic: 'a', payload: Uint8Array.of(1), retain: false }),
    encodePacket({ cmd: 'publish', topic: 'a', payload: Uint8Array.of(1), qos: 1, messageId: 1, dup: true, retain: false }),
    encodePacket({ cmd: 'puback', messageId: 1, reasonCode: 0 }),
    // A Topic Alias of 1 in the property section.
    Uint8Array.of(0x32, 9, 0, 1, 97, 0, 1, 3, 0x23, 0, 1, 1),
    // A Subscription Identifier, which only a broker sends.
    Uint8Array.of(0x32, 8, 0, 1, 97, 0, 1, 2, 0x0b, 1, 1),
    // A Remaining Length that is not the length of the packet.
    changed(1, (packet[1] ?? 0) + 1),
    changed(1, (packet[1] ?? 0) - 1),
    // A topic with a wildcard, which the encoder refuses.
    changed(4, 0x23),
    joined(packet, Uint8Array.of(0)).subarray(0, packet.length - 1),
    packet.subarray(0, 3),
  ])
    expect(withPacket(stored)).toMatchObject({ outcome: 'unreadable', reason: 'record', offset: start.length });
});

test('a record that does not apply to the state before it makes the segment unreadable', () => {
  const publication = capturePublication('a', 'b', undefined, true, 100, 100, 1);
  const state: JournalState = {
    ...empty,
    nextSequence: 5,
    publications: [{ sequence: 2, messageId: 1, publication }],
    releases: [{ messageId: 2, topic: 'r' }],
    delivered: [3],
  };
  const segmentRecord = snapshotRecords(owner, state)[0];
  if (segmentRecord === undefined) throw new Error('A snapshot starts with the segment record');
  for (const records of [
    [{ kind: 'acknowledged', messageId: 9 }],
    [{ kind: 'withdrawn', messageId: 2 }],
    [{ kind: 'received', messageId: 9 }],
    // The stored publication has QoS 1, so no PUBREC answers it.
    [{ kind: 'received', messageId: 1 }],
    [{ kind: 'completed', messageId: 1 }],
    [{ kind: 'delivered', messageId: 3 }],
    [{ kind: 'released', messageId: 4 }],
    [{ kind: 'publication', sequence: 5, messageId: 1, publication }],
    [{ kind: 'publication', sequence: 5, messageId: 2, publication }],
    [{ kind: 'publication', sequence: 4, messageId: 7, publication }],
    [{ kind: 'publication', sequence: 6, messageId: 7, publication }],
    [{ kind: 'releasing', messageId: 7, topic: 't' }],
    [{ kind: 'ended', time }],
    [
      { kind: 'connected', sessionExpiryInterval: 1 },
      { kind: 'connected', sessionExpiryInterval: 1 },
    ],
    [{ kind: 'closed' }, { kind: 'delivered', messageId: 8 }],
    [segmentRecord],
  ] satisfies JournalRecord[][])
    expect(recoverSegment(segment(state, records), generation)).toMatchObject({ outcome: 'unreadable', reason: 'record' });
  const closed = segment(state, [{ kind: 'closed' }], [{ kind: 'delivered', messageId: 8 }]);
  expect(recoverSegment(closed, generation)).toMatchObject({ outcome: 'unreadable', reason: 'record' });
  const frame = (records: readonly JournalRecord[]) =>
    joined(segmentPrefix(), encodeFrame({ generation, batch: 1, epoch: 0, time, records }));
  // A snapshot without the segment record, with it in second place, and with publications out of order.
  expect(recoverSegment(frame([]), generation)).toMatchObject({ outcome: 'unreadable', reason: 'record' });
  expect(recoverSegment(frame([{ kind: 'delivered', messageId: 1 }, segmentRecord]), generation)).toMatchObject({
    outcome: 'unreadable',
    reason: 'record',
  });
  for (const sequences of [[3, 3], [3, 2], [5]])
    expect(
      recoverSegment(
        frame([
          segmentRecord,
          ...sequences.map((sequence, index) => ({ kind: 'publication' as const, sequence, messageId: index + 1, publication })),
        ]),
        generation,
      ),
    ).toMatchObject({ outcome: 'unreadable', reason: 'record' });
  expect(
    recoverSegment(
      frame([
        segmentRecord,
        { kind: 'releasing', messageId: 1, topic: 't' },
        { kind: 'publication', sequence: 0, messageId: 1, publication },
      ]),
      generation,
    ),
  ).toMatchObject({ outcome: 'unreadable', reason: 'record' });
});

test('a frame or an epoch record of the wrong epoch makes the segment unreadable', () => {
  const state: JournalState = { ...empty, epoch: 3 };
  const start = encodeSegmentStart(generation, owner, state, time);
  const frame = (batch: number, epoch: number, records: readonly JournalRecord[]) =>
    encodeFrame({ generation, batch, epoch, time, records });
  const next = frame(2, 3, [
    { kind: 'epoch', epoch: 4, established: true },
    { kind: 'delivered', messageId: 1 },
  ]);
  expect(recovered(joined(start, next, frame(3, 4, []))).state).toMatchObject({ epoch: 4, delivered: [1] });
  for (const epoch of [2, 4])
    expect(recoverSegment(joined(start, frame(2, epoch, [])), generation)).toMatchObject({
      outcome: 'unreadable',
      reason: 'epoch',
      offset: start.length,
    });
  expect(recoverSegment(joined(start, next, frame(3, 3, [])), generation)).toMatchObject({
    outcome: 'unreadable',
    reason: 'epoch',
    offset: start.length + next.length,
  });
  for (const epoch of [3, 5, 0])
    expect(recoverSegment(joined(start, frame(2, 3, [{ kind: 'epoch', epoch, established: true }])), generation)).toMatchObject({
      outcome: 'unreadable',
      reason: 'epoch',
    });
  const snapshot = joined(segmentPrefix(), frame(1, 2, snapshotRecords(owner, state)));
  expect(recoverSegment(snapshot, generation)).toMatchObject({
    outcome: 'unreadable',
    reason: 'epoch',
    offset: segmentPrefixBytes,
  });
});

test('a writer that compacts when the rule says so keeps a segment within the bound', () => {
  expect(compactionThreshold(0)).toBe(1024 * 1024);
  expect(compactionThreshold(1024 * 1024)).toBe(4 * 1024 * 1024);
  expect(compactionDue(1024 * 1024, 100)).toBe(false);
  expect(compactionDue(1024 * 1024 + 1, 100)).toBe(true);
  expect(compactionDue(2 * 1024 * 1024, 600_000)).toBe(false);
  const next = random(5);
  const largestFrame = 300_000;
  let largest = 0;
  for (let round = 0; round < 200; round++) {
    const snapshotBytes = below(next, 800_000);
    let segmentBytes = snapshotBytes;
    while (!compactionDue(segmentBytes, snapshotBytes)) {
      segmentBytes += 1 + below(next, largestFrame);
      largest = Math.max(largest, segmentBytes - segmentBytesBound(snapshotBytes, largestFrame));
    }
  }
  expect(largest).toBeLessThanOrEqual(0);
  expect(largest).toBeGreaterThan(-largestFrame);
});

// The property tests below use fixed seeds. MQTT_TEST_JOURNAL_SEGMENTS sets the number of generated segments, and with it
// every bit of every byte is flipped where the default run flips one bit of each byte:
//   MQTT_TEST_JOURNAL_SEGMENTS=300 pnpm -s test test/journal-format.test.ts
const requested = Number(process.env['MQTT_TEST_JOURNAL_SEGMENTS'] ?? 0);
const exhaustive = Number.isSafeInteger(requested) && requested > 0;
const segmentCount = exhaustive ? requested : 10;
const propertyTimeout = exhaustive ? 3_600_000 : 20_000;

function generated(seed: number): GeneratedSegment[] {
  const next = random(seed);
  return Array.from({ length: segmentCount }, () => generateSegment(next, 2 + below(next, 7)));
}

/** What a recovery must return when the first `frames` frames of `segment` are intact and the rest is a torn tail. */
function prefixOf(segment: GeneratedSegment, frames: number, clean: boolean): string {
  if (frames === 0) return canonical({ outcome: 'incomplete' });
  return canonical({
    outcome: 'recovered',
    owner: segment.owner,
    state: segment.states[frames - 1],
    batches: frames,
    tail: clean ? 'clean' : 'torn',
    bytes: segment.ends[frames - 1],
  });
}

function outcome(bytes: ReadonlyBytes, generationOf: number): string {
  const result = recoverSegment(bytes, generationOf);
  return canonical(result.outcome === 'recovered' ? { ...result, time: undefined } : { ...result, detail: undefined });
}

/** Whether `result` is one of the states a commit of `segment` made durable, or a refusal. */
function committed(result: SegmentRecovery, segment: GeneratedSegment): boolean {
  if (result.outcome !== 'recovered') return true;
  return (
    canonical(result.state) === canonical(segment.states[result.batches - 1]) && result.bytes === segment.ends[result.batches - 1]
  );
}

test('every truncation of a segment recovers the frames that are whole', { timeout: propertyTimeout }, () => {
  const wrong: string[] = [];
  let cases = 0;
  for (const [index, segment] of generated(1).entries()) {
    expect(outcome(segment.bytes, segment.generation)).toBe(prefixOf(segment, segment.ends.length, true));
    for (let cut = 0; cut <= segment.bytes.length; cut++) {
      const frames = segment.ends.filter((end) => end <= cut).length;
      const clean = frames > 0 && segment.ends[frames - 1] === cut;
      cases++;
      if (outcome(segment.bytes.subarray(0, cut), segment.generation) !== prefixOf(segment, frames, clean))
        wrong.push('segment ' + String(index) + ' cut at ' + String(cut));
    }
  }
  expect(wrong).toEqual([]);
  expect(cases).toBeGreaterThan(segmentCount * 300);
});

test('a flipped bit is a torn tail in the last frame and a refusal anywhere else', { timeout: propertyTimeout }, () => {
  const next = random(2);
  const wrong: string[] = [];
  let cases = 0;
  for (const [index, segment] of generated(2).entries()) {
    const last = segment.ends.length;
    for (let offset = 0; offset < segment.bytes.length; offset++) {
      const frame = segment.ends.findIndex((end) => offset < end) + 1;
      const start = frame === 1 ? segmentPrefixBytes : (segment.ends[frame - 2] ?? 0);
      let expected: string;
      if (offset < segmentPrefixBytes - 1) expected = canonical({ outcome: 'unreadable', reason: 'damaged', offset: 0 });
      else if (offset === segmentPrefixBytes - 1) expected = canonical({ outcome: 'unreadable', reason: 'version', offset: 0 });
      else if (frame < last) expected = canonical({ outcome: 'unreadable', reason: 'damaged', offset: start });
      else expected = prefixOf(segment, last - 1, false);
      for (const bit of exhaustive ? [0, 1, 2, 3, 4, 5, 6, 7] : [below(next, 8)]) {
        const damaged = Uint8Array.from(segment.bytes);
        damaged[offset] = (damaged[offset] ?? 0) ^ (1 << bit);
        cases++;
        if (outcome(damaged, segment.generation) !== expected)
          wrong.push('segment ' + String(index) + ' byte ' + String(offset) + ' bit ' + String(bit));
      }
    }
  }
  expect(wrong).toEqual([]);
  expect(cases).toBeGreaterThan(segmentCount * 300);
});

test('zeros, noise and frames of an older segment after a frame are a torn tail', { timeout: propertyTimeout }, () => {
  const next = random(4);
  const wrong: string[] = [];
  const segments = generated(4);
  for (const [index, segment] of segments.entries()) {
    const older = segments[(index + 1) % segments.length];
    for (let frames = 0; frames <= segment.ends.length; frames++) {
      const kept = segment.bytes.subarray(0, frames === 0 ? segmentPrefixBytes : segment.ends[frames - 1]);
      const noise = Uint8Array.from({ length: 1 + below(next, 600) }, () => below(next, 256));
      const tails = [
        new Uint8Array(1 + below(next, 5000)),
        noise,
        // The frames of another segment, as a file system may leave them in blocks it reused.
        older === undefined || older.generation === segment.generation ? noise : older.bytes.subarray(segmentPrefixBytes),
        // The header of the next frame cut short, then zeros.
        joined(segment.bytes.subarray(kept.length, kept.length + below(next, frameHeaderBytes)), new Uint8Array(below(next, 100))),
      ];
      for (const [kind, tail] of tails.entries()) {
        const clean = tail.length === 0;
        if (outcome(joined(kept, tail), segment.generation) !== prefixOf(segment, frames, clean))
          wrong.push('segment ' + String(index) + ' after frame ' + String(frames) + ' tail ' + String(kind));
      }
    }
    if (segment.ends.length > 2) {
      // Zeros in place of a frame in the middle: the frames after it prove that a commit covered it.
      const [first = 0, second = 0] = segment.ends;
      const holed = Uint8Array.from(segment.bytes);
      holed.fill(0, first, second);
      if (outcome(holed, segment.generation) !== canonical({ outcome: 'unreadable', reason: 'damaged', offset: first }))
        wrong.push('segment ' + String(index) + ' hole');
    }
  }
  expect(wrong).toEqual([]);
});

test('no damage recovers a state that no commit made durable', { timeout: propertyTimeout }, () => {
  const next = random(6);
  const wrong: string[] = [];
  for (const [index, segment] of generated(6).entries()) {
    for (let round = 0; round < (exhaustive ? 2000 : 400); round++) {
      const damaged = Uint8Array.from(segment.bytes);
      const kind = below(next, 4);
      const from = below(next, damaged.length);
      const to = Math.min(damaged.length, from + 1 + below(next, 64));
      if (kind === 0) for (let offset = from; offset < to; offset++) damaged[offset] = below(next, 256);
      else if (kind === 1) damaged.fill(0, from, to);
      else if (kind === 2) damaged.copyWithin(from, below(next, damaged.length), damaged.length);
      else
        for (let flips = 1 + below(next, 4); flips > 0; flips--) {
          const offset = below(next, damaged.length);
          damaged[offset] = (damaged[offset] ?? 0) ^ (1 << below(next, 8));
        }
      const cut = next() < 0.3 ? damaged.subarray(0, below(next, damaged.length + 1)) : damaged;
      if (!committed(recoverSegment(cut, segment.generation), segment))
        wrong.push('segment ' + String(index) + ' round ' + String(round));
    }
  }
  expect(wrong).toEqual([]);
});
