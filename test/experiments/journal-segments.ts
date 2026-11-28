import { crc32 } from 'node:zlib';
import {
  emptyJournalState,
  encodeFrame,
  encodeSegmentStart,
  frameHeaderBytes,
  type JournalRecord,
  type JournalState,
  type SegmentOwner,
  type StoredPublication,
  type StoredRelease,
} from '../../src/journalFormat.js';
import { capturePublication } from '../../src/publication.js';
import type { ReadonlyBytes } from '../../src/util/bytes.js';

// Test support for the journal format. The package does not export it.

/** A source of numbers in [0, 1) that repeats for a seed (mulberry32). */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

/** A whole number from 0 up to and without `limit`. */
export function below(next: () => number, limit: number): number {
  return Math.floor(next() * limit);
}

function pick<Item>(next: () => number, items: readonly Item[]): Item | undefined {
  return items[below(next, items.length)];
}

/** A segment with the state a recovery must return after each of its frames. */
export interface GeneratedSegment {
  readonly generation: number;
  readonly owner: SegmentOwner;
  readonly bytes: ReadonlyBytes;
  /** The offset after frame k, at index k - 1. */
  readonly ends: readonly number[];
  /** The state after frame k, at index k - 1. */
  readonly states: readonly JournalState[];
}

/** The session state as plain values. It follows the record meanings in docs/journal.md and shares no code with the reducer under test. */
interface Model {
  clientId: string;
  broker: string;
  epoch: number;
  established: boolean;
  nextSequence: number;
  publications: StoredPublication[];
  releases: StoredRelease[];
  delivered: number[];
  requestedQos: 0 | 1 | 2;
  grantedQos: 0 | 1 | 2;
  subscribed: boolean;
  connection: { sessionExpiryInterval: number; endedAt: number | undefined } | undefined;
  closed: boolean;
}

function snapshot(model: JournalState): JournalState {
  return {
    ...model,
    publications: [...model.publications],
    releases: [...model.releases],
    delivered: [...model.delivered],
    connection: model.connection === undefined ? undefined : { ...model.connection },
  };
}

function qosLevel(next: () => number): 0 | 1 | 2 {
  const value = below(next, 3);
  return value === 0 ? 0 : value === 1 ? 1 : 2;
}

const topics = ['a', 'sensor/7/temperature', 'größe/µ', 'x'.repeat(130)];

function publication(next: () => number): StoredPublication['publication'] {
  const text = next() < 0.3;
  const payload = text
    ? 'payload ' + String(below(next, 1000))
    : Uint8Array.from({ length: below(next, 200) }, () => below(next, 256));
  const options =
    next() < 0.5
      ? {}
      : {
          ...(next() < 0.5 ? { retain: true } : {}),
          ...(text && next() < 0.5 ? { payloadFormatIndicator: 1 as const } : {}),
          ...(next() < 0.4 ? { messageExpiryInterval: below(next, 100_000) } : {}),
          ...(next() < 0.4 ? { contentType: 'application/octet-stream' } : {}),
          ...(next() < 0.3 ? { responseTopic: 'replies/' + String(below(next, 9)) } : {}),
          ...(next() < 0.3 ? { correlationData: Uint8Array.from({ length: 1 + below(next, 8) }, () => below(next, 256)) } : {}),
          ...(next() < 0.3 ? { userProperties: [['key', 'value ' + String(below(next, 9))] as const, ['k', ''] as const] } : {}),
        };
  const qos = next() < 0.5 ? 1 : 2;
  const captured = capturePublication(pick(next, topics) ?? 'a', payload, options, true, 1_000_000, 1_000_000, qos);
  return qos === 2 ? { ...captured, qos } : captured;
}

/**
 * Generate a segment of `frames` frames. The snapshot holds the state after some earlier history, so it has gaps in its
 * sequence numbers, releases and inbound identifiers.
 */
export function generateSegment(next: () => number, frames: number): GeneratedSegment {
  const generation = 1 + below(next, 2 ** 40);
  const owner: SegmentOwner = {
    processId: below(next, 2 ** 22),
    uptime: below(next, 2 ** 20),
    host: 'host-' + String(below(next, 99)),
    token: String(below(next, 2 ** 31)),
  };
  const model: Model = {
    ...emptyJournalState('client-' + String(below(next, 99)), 'mqtts://broker.example:8883'),
    publications: [],
    releases: [],
    delivered: [],
    connection: undefined,
  };
  /** One change the model allows in its current state, applied to the model and returned as the record a writer appends. */
  function step(time: number): JournalRecord | undefined {
    const choice = below(next, 12);
    const stored = pick(next, model.publications);
    const release = pick(next, model.releases);
    const inbound = pick(next, model.delivered);
    if (choice <= 2) {
      // A small identifier range makes freed identifiers return soon.
      const messageId = 1 + below(next, 24);
      if (
        model.publications.some((entry) => entry.messageId === messageId) ||
        model.releases.some((entry) => entry.messageId === messageId)
      )
        return undefined;
      const entry = { sequence: model.nextSequence, messageId, publication: publication(next) };
      model.nextSequence += 1;
      model.publications.push(entry);
      return { kind: 'publication', ...entry };
    }
    if (choice === 3 && stored !== undefined) {
      model.publications = model.publications.filter((entry) => entry !== stored);
      return { kind: next() < 0.8 ? 'acknowledged' : 'withdrawn', messageId: stored.messageId };
    }
    if (choice === 4 && stored?.publication.qos === 2) {
      model.publications = model.publications.filter((entry) => entry !== stored);
      model.releases.push({ messageId: stored.messageId, topic: stored.publication.topic });
      return { kind: 'received', messageId: stored.messageId };
    }
    if (choice === 5 && release !== undefined) {
      model.releases = model.releases.filter((entry) => entry !== release);
      return { kind: 'completed', messageId: release.messageId };
    }
    if (choice === 6) {
      const messageId = 1 + below(next, 6);
      if (model.delivered.includes(messageId)) return undefined;
      model.delivered.push(messageId);
      return { kind: 'delivered', messageId };
    }
    if (choice === 7 && inbound !== undefined) {
      model.delivered = model.delivered.filter((messageId) => messageId !== inbound);
      return { kind: 'released', messageId: inbound };
    }
    if (choice === 8) {
      if (model.connection !== undefined && model.connection.endedAt === undefined) {
        model.connection = { ...model.connection, endedAt: time };
        return { kind: 'ended', time };
      }
      const sessionExpiryInterval = below(next, 5000);
      model.established = true;
      model.connection = { sessionExpiryInterval, endedAt: undefined };
      return { kind: 'connected', sessionExpiryInterval };
    }
    if (choice === 9) {
      model.requestedQos = qosLevel(next);
      model.grantedQos = qosLevel(next);
      model.subscribed = next() < 0.5;
      return { kind: 'fact', requestedQos: model.requestedQos, grantedQos: model.grantedQos, subscribed: model.subscribed };
    }
    if (choice === 10 && next() < 0.3) {
      model.epoch += 1;
      model.established = next() < 0.5;
      model.publications = [];
      model.releases = [];
      model.delivered = [];
      model.requestedQos = 0;
      model.grantedQos = 0;
      model.subscribed = false;
      model.connection = undefined;
      return { kind: 'epoch', epoch: model.epoch, established: model.established };
    }
    return undefined;
  }
  let time = 1_764_000_000_000 + below(next, 1_000_000);
  for (let index = below(next, 30); index > 0; index--) step(time);
  const start = encodeSegmentStart(generation, owner, snapshot(model), time);
  const parts: Uint8Array[] = [start];
  const ends = [start.length];
  const states = [snapshot(model)];
  for (let batch = 2; batch <= frames; batch++) {
    time += 1 + below(next, 5000);
    const { epoch } = model;
    const records: JournalRecord[] = [];
    for (let index = below(next, 7); index > 0; index--) {
      const record = step(time);
      if (record !== undefined) records.push(record);
    }
    if (batch === frames && next() < 0.2) {
      model.closed = true;
      records.push({ kind: 'closed' });
    }
    const frame = encodeFrame({ generation, batch, epoch, time, records });
    parts.push(frame);
    ends.push((ends.at(-1) ?? 0) + frame.length);
    states.push(snapshot(model));
  }
  return { generation, owner, bytes: joined(...parts), ends, states };
}

/** A text that is equal for equal values, whatever the order of their keys. A key with the value undefined is left out. */
export function canonical(value: unknown): string {
  if (value instanceof Uint8Array) return 'bytes:' + Buffer.from(value).toString('hex');
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return '[' + items.map(canonical).join(',') + ']';
  }
  if (typeof value === 'object' && value !== null) {
    const fields = new Map<string, unknown>(Object.entries(value));
    const parts: string[] = [];
    for (const key of [...fields.keys()].sort()) {
      const field = fields.get(key);
      if (field !== undefined) parts.push(key + ':' + canonical(field));
    }
    return '{' + parts.join(',') + '}';
  }
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

/**
 * A frame from raw record bytes, written field by field from docs/journal.md. A test uses it for frames that
 * `encodeFrame` refuses to write, such as one with an unknown record type.
 */
export function rawFrame(
  generation: number,
  batch: number,
  epoch: number,
  time: number,
  records: ReadonlyBytes,
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(frameHeaderBytes + records.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x4d51_4a46);
  view.setUint32(4, records.length);
  view.setUint32(12, Math.floor(generation / 2 ** 32));
  view.setUint32(16, generation % 2 ** 32);
  view.setUint32(20, batch);
  view.setUint32(24, epoch);
  view.setUint32(28, Math.floor(time / 2 ** 32));
  view.setUint32(32, time % 2 ** 32);
  bytes.set(records, frameHeaderBytes);
  view.setUint32(8, crc32(bytes.subarray(12)));
  return bytes;
}

/** One raw record: the type byte, the length of the body and the body. */
export function rawRecord(type: number, body: readonly number[] | ReadonlyBytes = []): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(5 + body.length);
  bytes[0] = type;
  new DataView(bytes.buffer).setUint32(1, body.length);
  bytes.set(body, 5);
  return bytes;
}

/** `parts` one after the other. */
export function joined(...parts: readonly ReadonlyBytes[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
