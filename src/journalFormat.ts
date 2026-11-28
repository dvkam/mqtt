import { crc32 } from 'node:zlib';
import type { OutgoingPublication } from './publication.js';
import { publishSize } from './publicationAdmission.js';
import { variableByteIntegerSize, type ReadonlyBytes, type ReadonlyDeep } from './util/bytes.js';
import { utf8Length } from './util/utf8.js';
import { validateMqttString } from './util/validateTopic.js';
import { decodeFramedPacket, encodePacket, type FramedPacket } from './wireCodec.js';
import { decodeUtf8 } from './wireProperties.js';

/**
 * The byte format of a session journal segment, version 1, and its recovery rules. `docs/journal.md` describes the
 * format. This module reads and writes bytes in memory only. The storage of a later change reads and writes the files.
 * No entry point exports it yet.
 */

/** The version byte this module writes and the only one it reads. */
export const journalFormatVersion = 1;
/** A segment starts with the ASCII text `MQTTJNL` and the version byte. */
export const segmentPrefixBytes = 8;
/** Magic, length, CRC-32, generation, batch, epoch and time. The records follow. */
export const frameHeaderBytes = 36;

const recordHeaderBytes = 5;
const prefixText: readonly number[] = [0x4d, 0x51, 0x54, 0x54, 0x4a, 0x4e, 0x4c];
// The ASCII text `MQJF`.
const frameMagic = 0x4d51_4a46;
const checkedFrom = 12;
const generationAt = 12;
const batchAt = 20;
const epochAt = 24;
const timeAt = 28;
const maxUint32 = 0xffff_ffff;
const twoToThe32 = 0x1_0000_0000;
const megabyte = 1024 * 1024;
const textEncoder = new TextEncoder();

/** The process that wrote a segment. The storage reads it to decide whether that process still runs. */
export interface SegmentOwner {
  readonly processId: number;
  /** Whole seconds since the machine started, when the process opened the journal. */
  readonly uptime: number;
  readonly host: string;
  /** A random text the process chose, so two processes with one process ID differ. */
  readonly token: string;
}

/** A QoS 1 or QoS 2 publication whose PUBACK or PUBREC has not arrived. */
export interface StoredPublication {
  /** The number of the publication within the journal. It never repeats, and it gives the resend order. */
  readonly sequence: number;
  readonly messageId: number;
  readonly publication: ReadonlyDeep<OutgoingPublication>;
}

/** A QoS 2 publication that has its PUBREC and waits for PUBCOMP. Only the topic is left of it. */
export interface StoredRelease {
  readonly messageId: number;
  readonly topic: string;
}

/**
 * The session state that a segment holds. The arrays have the order in which a resumed session continues them:
 * `releases` in the order the PUBRECs arrived, and `publications` in the order of their first write.
 */
export interface JournalState {
  readonly clientId: string;
  /** The name the caller chose for the broker. */
  readonly broker: string;
  /** Counts the broker sessions the client knew. */
  readonly epoch: number;
  /** Whether a CONNACK established the session of this epoch. */
  readonly established: boolean;
  readonly nextSequence: number;
  readonly publications: readonly StoredPublication[];
  readonly releases: readonly StoredRelease[];
  /** The Packet Identifiers of inbound QoS 2 publications whose handler fulfilled and that wait for PUBREL. */
  readonly delivered: readonly number[];
  /** The highest QoS a SUBSCRIBE of this epoch asked for. */
  readonly requestedQos: 0 | 1 | 2;
  /** The highest QoS a SUBACK of this epoch granted. */
  readonly grantedQos: 0 | 1 | 2;
  /** Whether every subscription of the reconnect options was acknowledged in this epoch. */
  readonly subscribed: boolean;
  /**
   * The last connection of this epoch, or undefined when it had none. `endedAt` is the wall clock time in milliseconds
   * at which the connection was last known to be open, and undefined while it is open.
   */
  readonly connection: Readonly<{ sessionExpiryInterval: number; endedAt: number | undefined }> | undefined;
  /** Whether the writer closed the journal, so no process owns the segment. */
  readonly closed: boolean;
}

/**
 * One change of the session state. A writer appends one record for each change that took effect, and recovery applies
 * the records in order. `segment` and `releasing` occur only in the snapshot, which is the first frame of a segment.
 */
export type JournalRecord =
  | Readonly<{
      kind: 'segment';
      owner: SegmentOwner;
      clientId: string;
      broker: string;
      epoch: number;
      established: boolean;
      nextSequence: number;
    }>
  | Readonly<{ kind: 'publication'; sequence: number; messageId: number; publication: ReadonlyDeep<OutgoingPublication> }>
  | Readonly<{
      /**
       * `acknowledged` ends a publication with a PUBACK or a refusing PUBREC. `received` moves it to the releases at a
       * PUBREC below 0x80. `completed` ends a release at PUBCOMP. `withdrawn` ends a publication that was never written.
       * `delivered` stores an inbound Packet Identifier and `released` removes it at PUBREL.
       */
      kind: 'acknowledged' | 'received' | 'completed' | 'withdrawn' | 'delivered' | 'released';
      messageId: number;
    }>
  | Readonly<{ kind: 'releasing'; messageId: number; topic: string }>
  | Readonly<{ kind: 'epoch'; epoch: number; established: boolean }>
  | Readonly<{ kind: 'connected'; sessionExpiryInterval: number }>
  | Readonly<{ kind: 'ended'; time: number }>
  | Readonly<{ kind: 'fact'; requestedQos: 0 | 1 | 2; grantedQos: 0 | 1 | 2; subscribed: boolean }>
  | Readonly<{ kind: 'closed' }>;

/** One commit batch. A writer syncs a frame before it writes the next one. */
export interface JournalFrame {
  /** The generation of the segment, which is the number in its file name. */
  readonly generation: number;
  /** Counts from 1 within a segment. */
  readonly batch: number;
  /** The session epoch before the first record of the frame. */
  readonly epoch: number;
  /** The wall clock time of the write, in milliseconds since 1970. */
  readonly time: number;
  readonly records: readonly JournalRecord[];
}

/**
 * Why a segment cannot be read. `version` is a format version other than 1. `damaged` is a frame that fails its checks
 * while a later frame passes them, so a commit covered the damaged bytes. `record` is a record that this version does not
 * know, that is malformed, or that does not apply to the state before it. `epoch` is a frame or an `epoch` record that
 * does not continue the epoch before it.
 */
export type JournalDefect = 'version' | 'damaged' | 'record' | 'epoch';

/** `offset` is the first byte of the prefix or of the frame that has the defect. */
type Unreadable = Readonly<{ outcome: 'unreadable'; reason: JournalDefect; offset: number; detail: string }>;

/** No frame of the segment is valid. Its writer stopped before the snapshot was written, so the segment holds no state. */
type Incomplete = Readonly<{ outcome: 'incomplete' }>;

/**
 * The frames of a segment up to the first one that is not valid, with the offset of each. `tail` is `torn` when bytes
 * follow them, which no commit covered. `bytes` is the offset after the last valid frame.
 */
export type SegmentRead =
  | Readonly<{
      outcome: 'read';
      frames: readonly JournalFrame[];
      offsets: readonly number[];
      tail: 'clean' | 'torn';
      bytes: number;
    }>
  | Incomplete
  | Unreadable;

/** The state after the valid frames of a segment. `time` is the time of the last one, and `batches` their count. */
export type SegmentRecovery =
  | Readonly<{
      outcome: 'recovered';
      owner: SegmentOwner;
      state: JournalState;
      batches: number;
      time: number;
      tail: 'clean' | 'torn';
      bytes: number;
    }>
  | Incomplete
  | Unreadable;

class Defect extends Error {
  readonly reason: JournalDefect;
  constructor(reason: JournalDefect, message: string) {
    super(message);
    this.reason = reason;
  }
}

function malformed(message: string): Defect {
  return new Defect('record', message);
}

function integer(value: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > maximum) throw new RangeError('Journal ' + name + ' is out of range');
  return value;
}

function text(value: string, name: string): string {
  if (!validateMqttString(value)) throw new RangeError('Journal ' + name + ' is not an MQTT UTF-8 string');
  return value;
}

function textBytes(value: string, name: string): number {
  return 2 + utf8Length(text(value, name));
}

/** The PUBLISH that stores `publication`, as the session first writes it, with its Packet Identifier and without DUP. */
function storedPacket(publication: ReadonlyDeep<OutgoingPublication>, messageId: number): Uint8Array<ArrayBuffer> {
  const { topic, payload, retain, properties, qos = 1 } = publication;
  return encodePacket(
    properties === undefined
      ? { cmd: 'publish', topic, payload, qos, messageId, dup: false, retain }
      : { cmd: 'publish', topic, payload, qos, messageId, dup: false, retain, ...properties },
  );
}

function storedPacketBytes(publication: ReadonlyDeep<OutgoingPublication>): number {
  const { topic, payloadBytes, propertyBytes, qos = 1 } = publication;
  return publishSize(utf8Length(topic), payloadBytes, propertyBytes, qos);
}

/** The size of `record` in a frame, with its five-byte header. */
export function recordBytes(record: JournalRecord): number {
  let body: number;
  switch (record.kind) {
    case 'segment':
      body =
        21 +
        textBytes(record.owner.host, 'host') +
        textBytes(record.owner.token, 'token') +
        textBytes(record.clientId, 'clientId') +
        textBytes(record.broker, 'broker');
      break;
    case 'publication':
      body = 8 + storedPacketBytes(record.publication);
      break;
    case 'acknowledged':
    case 'received':
    case 'completed':
    case 'withdrawn':
    case 'delivered':
    case 'released':
      body = 2;
      break;
    case 'releasing':
      body = 2 + textBytes(record.topic, 'topic');
      break;
    case 'epoch':
      body = 5;
      break;
    case 'connected':
      body = 4;
      break;
    case 'ended':
      body = 8;
      break;
    case 'fact':
      body = 3;
      break;
    case 'closed':
      body = 0;
      break;
  }
  return recordHeaderBytes + body;
}

/** The size of the frame that holds `records`. */
export function frameBytes(records: readonly JournalRecord[]): number {
  let size = frameHeaderBytes;
  for (const record of records) size += recordBytes(record);
  return size;
}

const recordTypes = {
  segment: 1,
  publication: 2,
  acknowledged: 3,
  received: 4,
  completed: 5,
  withdrawn: 6,
  delivered: 7,
  released: 8,
  releasing: 9,
  epoch: 10,
  connected: 11,
  ended: 12,
  fact: 13,
  closed: 14,
} as const satisfies Record<JournalRecord['kind'], number>;

const identifierKinds = {
  3: 'acknowledged',
  4: 'received',
  5: 'completed',
  6: 'withdrawn',
  7: 'delivered',
  8: 'released',
} as const;

class FrameWriter {
  readonly bytes: Uint8Array<ArrayBuffer>;
  private readonly view: DataView;
  private offset = 0;

  constructor(size: number) {
    this.bytes = new Uint8Array(size);
    this.view = new DataView(this.bytes.buffer);
  }

  uint8(value: number): void {
    this.view.setUint8(this.offset, value);
    this.offset += 1;
  }

  uint16(value: number): void {
    this.view.setUint16(this.offset, value);
    this.offset += 2;
  }

  uint32(value: number): void {
    this.view.setUint32(this.offset, value);
    this.offset += 4;
  }

  /** A safe integer in eight bytes, because a generation, a sequence number and a time outgrow 32 bits. */
  uint53(value: number): void {
    this.uint32(Math.floor(value / twoToThe32));
    this.uint32(value % twoToThe32);
  }

  string(value: string): void {
    const { written } = textEncoder.encodeInto(value, this.bytes.subarray(this.offset + 2));
    this.uint16(written);
    this.offset += written;
  }

  record(record: JournalRecord): void {
    const end = this.offset + recordBytes(record);
    this.uint8(recordTypes[record.kind]);
    this.uint32(end - this.offset - 4);
    this.fields(record);
    if (this.offset !== end) throw new RangeError('Journal record does not have the size recordBytes gives');
  }

  private fields(record: JournalRecord): void {
    switch (record.kind) {
      case 'segment':
        this.uint32(integer(record.owner.processId, maxUint32, 'process ID'));
        this.uint32(integer(record.owner.uptime, maxUint32, 'uptime'));
        this.uint32(integer(record.epoch, maxUint32, 'epoch'));
        this.uint8(record.established ? 1 : 0);
        this.uint53(integer(record.nextSequence, Number.MAX_SAFE_INTEGER, 'sequence number'));
        this.string(record.owner.host);
        this.string(record.owner.token);
        this.string(record.clientId);
        this.string(record.broker);
        break;
      case 'publication': {
        const packet = storedPacket(record.publication, record.messageId);
        // recordBytes sized the record from the byte counts of the publication, which admission also trusts.
        if (packet.length !== storedPacketBytes(record.publication))
          throw new RangeError('Journal publication does not have the size its byte counts give');
        this.uint53(integer(record.sequence, Number.MAX_SAFE_INTEGER, 'sequence number'));
        this.bytes.set(packet, this.offset);
        this.offset += packet.length;
        break;
      }
      case 'acknowledged':
      case 'received':
      case 'completed':
      case 'withdrawn':
      case 'delivered':
      case 'released':
        this.uint16(packetIdentifier(record.messageId));
        break;
      case 'releasing':
        this.uint16(packetIdentifier(record.messageId));
        this.string(record.topic);
        break;
      case 'epoch':
        this.uint32(integer(record.epoch, maxUint32, 'epoch'));
        this.uint8(record.established ? 1 : 0);
        break;
      case 'connected':
        this.uint32(integer(record.sessionExpiryInterval, maxUint32, 'Session Expiry Interval'));
        break;
      case 'ended':
        this.uint53(integer(record.time, Number.MAX_SAFE_INTEGER, 'time'));
        break;
      case 'fact':
        this.uint8(integer(record.requestedQos, 2, 'requested QoS'));
        this.uint8(integer(record.grantedQos, 2, 'granted QoS'));
        this.uint8(record.subscribed ? 1 : 0);
        break;
      case 'closed':
        break;
    }
  }
}

function packetIdentifier(value: number): number {
  if (integer(value, 65_535, 'Packet Identifier') === 0) throw new RangeError('Journal Packet Identifier is out of range');
  return value;
}

/** The eight bytes that start a segment. */
export function segmentPrefix(): Uint8Array<ArrayBuffer> {
  return Uint8Array.of(...prefixText, journalFormatVersion);
}

/**
 * Encode one commit batch. Throws a RangeError for a value the format cannot hold, such as a text over 65,535 bytes or
 * a publication the PUBLISH encoder refuses.
 */
export function encodeFrame(frame: JournalFrame): Uint8Array<ArrayBuffer> {
  const size = frameBytes(frame.records);
  const writer = new FrameWriter(size);
  writer.uint32(frameMagic);
  writer.uint32(integer(size - frameHeaderBytes, maxUint32, 'frame length'));
  // The CRC-32 follows once the bytes it covers are written.
  writer.uint32(0);
  writer.uint53(integer(frame.generation, Number.MAX_SAFE_INTEGER, 'generation'));
  writer.uint32(integer(frame.batch, maxUint32, 'batch'));
  writer.uint32(integer(frame.epoch, maxUint32, 'epoch'));
  writer.uint53(integer(frame.time, Number.MAX_SAFE_INTEGER, 'time'));
  for (const record of frame.records) writer.record(record);
  const { bytes } = writer;
  new DataView(bytes.buffer).setUint32(8, crc32(bytes.subarray(checkedFrom)));
  return bytes;
}

/**
 * The records of a snapshot, which are everything `state` holds, with the `segment` record first. Recovery of a segment that
 * starts with them yields `state` again.
 */
export function snapshotRecords(owner: SegmentOwner, state: JournalState): JournalRecord[] {
  const { clientId, broker, epoch, established, nextSequence, connection, requestedQos, grantedQos, subscribed } = state;
  const records: JournalRecord[] = [{ kind: 'segment', owner, clientId, broker, epoch, established, nextSequence }];
  if (connection !== undefined) {
    records.push({ kind: 'connected', sessionExpiryInterval: connection.sessionExpiryInterval });
    if (connection.endedAt !== undefined) records.push({ kind: 'ended', time: connection.endedAt });
  }
  if (requestedQos !== 0 || grantedQos !== 0 || subscribed) records.push({ kind: 'fact', requestedQos, grantedQos, subscribed });
  for (const publication of state.publications) records.push({ kind: 'publication', ...publication });
  for (const release of state.releases) records.push({ kind: 'releasing', ...release });
  for (const messageId of state.delivered) records.push({ kind: 'delivered', messageId });
  if (state.closed) records.push({ kind: 'closed' });
  return records;
}

/** The first bytes of a new segment, which are the prefix and the snapshot of `state` as frame 1. */
export function encodeSegmentStart(
  generation: number,
  owner: SegmentOwner,
  state: JournalState,
  time: number,
): Uint8Array<ArrayBuffer> {
  const frame = encodeFrame({ generation, batch: 1, epoch: state.epoch, time, records: snapshotRecords(owner, state) });
  const bytes = new Uint8Array(segmentPrefixBytes + frame.length);
  bytes.set(segmentPrefix());
  bytes.set(frame, segmentPrefixBytes);
  return bytes;
}

/** The state of a journal that no connection has used. */
export function emptyJournalState(clientId: string, broker: string): JournalState {
  return {
    clientId,
    broker,
    epoch: 0,
    established: false,
    nextSequence: 0,
    publications: [],
    releases: [],
    delivered: [],
    requestedQos: 0,
    grantedQos: 0,
    subscribed: false,
    connection: undefined,
    closed: false,
  };
}

/**
 * A writer compacts a segment that is larger than this many bytes, which is 1 MiB, or four times its snapshot when that
 * is more.
 */
export function compactionThreshold(snapshotBytes: number): number {
  return Math.max(megabyte, 4 * snapshotBytes);
}

/** Whether a writer that is between two frames starts a new segment. `snapshotBytes` is the size of the segment's first frame. */
export function compactionDue(segmentBytes: number, snapshotBytes: number): boolean {
  return segmentBytes > compactionThreshold(snapshotBytes);
}

/**
 * The largest size a segment reaches when its writer applies `compactionDue` before each frame, which is the threshold
 * and one more frame.
 */
export function segmentBytesBound(snapshotBytes: number, largestFrameBytes: number): number {
  return compactionThreshold(snapshotBytes) + largestFrameBytes;
}

function sameBytes(first: ReadonlyBytes, second: ReadonlyBytes): boolean {
  if (first.length !== second.length) return false;
  for (let index = 0; index < first.length; index++) if (first[index] !== second[index]) return false;
  return true;
}

/**
 * Decode a stored PUBLISH with the session's own decoder. The result must encode to the stored bytes again, so a stored
 * packet is exactly what `storedPacket` writes. It has QoS 1 or 2, no DUP, the full topic name and no Topic Alias.
 */
function storedPublication(packet: ReadonlyBytes): Readonly<{ messageId: number; publication: ReadonlyDeep<OutgoingPublication> }> {
  const header = packet[0];
  if (header === undefined) throw malformed('Stored PUBLISH is empty');
  let decoded: FramedPacket;
  try {
    decoded = decodeFramedPacket(header, packet.subarray(1));
  } catch {
    throw malformed('Stored PUBLISH does not decode');
  }
  if (decoded.cmd !== 'publish' || (decoded.qos !== 1 && decoded.qos !== 2))
    throw malformed('Stored packet is not a QoS 1 or QoS 2 PUBLISH');
  const {
    topic,
    payload,
    retain = false,
    qos,
    messageId,
    payloadFormatIndicator,
    messageExpiryInterval,
    contentType,
    responseTopic,
    correlationData,
    userProperties,
  } = decoded;
  const properties =
    payloadFormatIndicator === undefined &&
    messageExpiryInterval === undefined &&
    contentType === undefined &&
    responseTopic === undefined &&
    correlationData === undefined &&
    userProperties === undefined
      ? undefined
      : { payloadFormatIndicator, messageExpiryInterval, contentType, responseTopic, correlationData, userProperties };
  // A Remaining Length of n bytes follows the fixed-header byte, and n is the size of the value it holds.
  let lengthBytes = 1;
  while (lengthBytes < 4 && variableByteIntegerSize(packet.length - 1 - lengthBytes) !== lengthBytes) lengthBytes++;
  const propertyBytes = packet.length - 1 - lengthBytes - 4 - utf8Length(topic) - payload.length;
  const captured = { topic, payload, payloadBytes: payload.length, retain, properties, propertyBytes };
  const publication: ReadonlyDeep<OutgoingPublication> = qos === 2 ? { ...captured, qos } : captured;
  let encoded: ReadonlyBytes;
  try {
    encoded = storedPacket(publication, messageId);
  } catch {
    throw malformed('Stored PUBLISH is not one the session writes');
  }
  if (!sameBytes(encoded, packet)) throw malformed('Stored PUBLISH is not one the session writes');
  return { messageId, publication };
}

class RecordReader {
  private readonly bytes: ReadonlyBytes;
  private readonly view: DataView;
  private offset: number;
  private end: number;

  constructor(bytes: ReadonlyBytes, start: number, end: number) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = start;
    this.end = end;
  }

  private take(size: number): number {
    const start = this.offset;
    if (size > this.end - start) throw malformed('Record is shorter than its fields');
    this.offset = start + size;
    return start;
  }

  private uint8(): number {
    return this.view.getUint8(this.take(1));
  }

  private uint16(): number {
    return this.view.getUint16(this.take(2));
  }

  private uint32(): number {
    return this.view.getUint32(this.take(4));
  }

  private uint53(): number {
    const high = this.uint32();
    const value = high * twoToThe32 + this.uint32();
    if (!Number.isSafeInteger(value)) throw malformed('Record holds a number over 2^53');
    return value;
  }

  private flag(): boolean {
    const value = this.uint8();
    if (value > 1) throw malformed('Record holds a flag other than 0 and 1');
    return value === 1;
  }

  private qos(): 0 | 1 | 2 {
    const value = this.uint8();
    if (value !== 0 && value !== 1 && value !== 2) throw malformed('Record holds a QoS above 2');
    return value;
  }

  private messageId(): number {
    const value = this.uint16();
    if (value === 0) throw malformed('Record holds Packet Identifier 0');
    return value;
  }

  private string(): string {
    const size = this.uint16();
    const start = this.take(size);
    const value = decodeUtf8(this.bytes, start, start + size);
    if (value === undefined) throw malformed('Record holds a text that is not an MQTT UTF-8 string');
    return value;
  }

  private body(type: number): JournalRecord {
    switch (type) {
      case recordTypes.segment: {
        const processId = this.uint32();
        const uptime = this.uint32();
        const epoch = this.uint32();
        const established = this.flag();
        const nextSequence = this.uint53();
        const host = this.string();
        const token = this.string();
        return {
          kind: 'segment',
          owner: { processId, uptime, host, token },
          clientId: this.string(),
          broker: this.string(),
          epoch,
          established,
          nextSequence,
        };
      }
      case recordTypes.publication: {
        const sequence = this.uint53();
        const start = this.take(this.end - this.offset);
        return { kind: 'publication', sequence, ...storedPublication(this.bytes.subarray(start, this.end)) };
      }
      case recordTypes.acknowledged:
      case recordTypes.received:
      case recordTypes.completed:
      case recordTypes.withdrawn:
      case recordTypes.delivered:
      case recordTypes.released:
        return { kind: identifierKinds[type], messageId: this.messageId() };
      case recordTypes.releasing:
        return { kind: 'releasing', messageId: this.messageId(), topic: this.string() };
      case recordTypes.epoch:
        return { kind: 'epoch', epoch: this.uint32(), established: this.flag() };
      case recordTypes.connected:
        return { kind: 'connected', sessionExpiryInterval: this.uint32() };
      case recordTypes.ended:
        return { kind: 'ended', time: this.uint53() };
      case recordTypes.fact:
        return { kind: 'fact', requestedQos: this.qos(), grantedQos: this.qos(), subscribed: this.flag() };
      case recordTypes.closed:
        return { kind: 'closed' };
      default:
        throw malformed('Unknown record type ' + String(type));
    }
  }

  /** The records up to the end the reader was given. Each record must fill its length exactly. */
  records(): JournalRecord[] {
    const records: JournalRecord[] = [];
    const frameEnd = this.end;
    while (this.offset < frameEnd) {
      const type = this.uint8();
      const length = this.uint32();
      if (length > frameEnd - this.offset) throw malformed('Record is longer than its frame');
      this.end = this.offset + length;
      records.push(this.body(type));
      if (this.offset !== this.end) throw malformed('Record is longer than its fields');
      this.end = frameEnd;
    }
    return records;
  }
}

/** The prefix, the frame checks and the search for a later frame, over one segment and its generation. */
class SegmentReader {
  private readonly bytes: ReadonlyBytes;
  private readonly view: DataView;
  private readonly generationHigh: number;
  private readonly generationLow: number;

  constructor(bytes: ReadonlyBytes, generation: number) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.generationHigh = Math.floor(generation / twoToThe32);
    this.generationLow = generation % twoToThe32;
  }

  hasPrefix(): boolean {
    return this.bytes.length >= segmentPrefixBytes && prefixText.every((byte, index) => this.bytes[index] === byte);
  }

  version(): number {
    return this.view.getUint8(segmentPrefixBytes - 1);
  }

  /**
   * The offset after the frame at `offset`, or undefined when no frame of this segment starts there. A frame of another
   * generation does not count, because a file system may hand a torn tail the blocks of a deleted segment.
   */
  frameEnd(offset: number): number | undefined {
    const { bytes, view } = this;
    if (offset + frameHeaderBytes > bytes.length || view.getUint32(offset) !== frameMagic) return undefined;
    const end = offset + frameHeaderBytes + view.getUint32(offset + 4);
    if (
      end > bytes.length ||
      view.getUint32(offset + generationAt) !== this.generationHigh ||
      view.getUint32(offset + generationAt + 4) !== this.generationLow ||
      crc32(bytes.subarray(offset + checkedFrom, end)) !== view.getUint32(offset + 8)
    )
      return undefined;
    return end;
  }

  batch(offset: number): number {
    return this.view.getUint32(offset + batchAt);
  }

  /** Decode the frame at `offset`, which `frameEnd` accepted. */
  frame(offset: number, end: number, generation: number): JournalFrame {
    const { view } = this;
    const time = view.getUint32(offset + timeAt) * twoToThe32 + view.getUint32(offset + timeAt + 4);
    if (!Number.isSafeInteger(time)) throw malformed('Frame holds a time over 2^53');
    return {
      generation,
      batch: this.batch(offset),
      epoch: view.getUint32(offset + epochAt),
      time,
      records: new RecordReader(this.bytes, offset + frameHeaderBytes, end).records(),
    };
  }

  /**
   * Whether a frame of this segment with a batch number of `batch` or more starts at `from` or later. A writer writes a
   * frame only after it synced the one before, so such a frame proves that a commit covered the bytes before it.
   */
  hasLaterFrame(from: number, batch: number): boolean {
    for (let offset = from; offset + frameHeaderBytes <= this.bytes.length; offset++)
      if (this.frameEnd(offset) !== undefined && this.batch(offset) >= batch) return true;
    return false;
  }
}

function unreadable(reason: JournalDefect, offset: number, detail: string): Unreadable {
  return { outcome: 'unreadable', reason, offset, detail };
}

/**
 * Read the frames of a segment. `generation` is the number in the segment's file name. The frames end at the first one
 * that is short, fails its CRC-32, belongs to another generation or does not have the next batch number. When a valid
 * frame with that batch number or a higher one follows, the segment is damaged. Otherwise the rest is a torn tail.
 */
export function readSegment(bytes: ReadonlyBytes, generation: number): SegmentRead {
  const reader = new SegmentReader(bytes, integer(generation, Number.MAX_SAFE_INTEGER, 'generation'));
  if (!reader.hasPrefix())
    return reader.hasLaterFrame(0, 1) ? unreadable('damaged', 0, 'The segment prefix is damaged') : { outcome: 'incomplete' };
  if (reader.version() !== journalFormatVersion)
    return unreadable('version', 0, 'The segment has format version ' + String(reader.version()));
  const frames: JournalFrame[] = [];
  const offsets: number[] = [];
  let offset = segmentPrefixBytes;
  while (offset < bytes.length) {
    const end = reader.frameEnd(offset);
    if (end === undefined || reader.batch(offset) !== frames.length + 1) break;
    try {
      frames.push(reader.frame(offset, end, generation));
    } catch (error) {
      if (error instanceof Defect) return unreadable(error.reason, offset, error.message);
      throw error;
    }
    offsets.push(offset);
    offset = end;
  }
  if (offset < bytes.length && reader.hasLaterFrame(offset, frames.length + 1))
    return unreadable('damaged', offset, 'A frame is damaged and a later frame is valid');
  if (frames.length === 0) return { outcome: 'incomplete' };
  return { outcome: 'read', frames, offsets, tail: offset === bytes.length ? 'clean' : 'torn', bytes: offset };
}

/** Applies records in order. A record that does not fit the state before it is a defect, because no writer produces it. */
class Replay {
  owner: SegmentOwner | undefined;
  private clientId = '';
  private broker = '';
  epoch = 0;
  private established = false;
  private nextSequence = 0;
  private lastSnapshotSequence = -1;
  private readonly publications = new Map<number, StoredPublication>();
  private readonly releases = new Map<number, string>();
  private readonly delivered = new Set<number>();
  private requestedQos: 0 | 1 | 2 = 0;
  private grantedQos: 0 | 1 | 2 = 0;
  private subscribed = false;
  private connection: JournalState['connection'];
  private closed = false;

  private publication(messageId: number): StoredPublication {
    const stored = this.publications.get(messageId);
    if (stored === undefined) throw malformed('Record names a publication that is not stored');
    return stored;
  }

  /** `snapshot` is true for the records of frame 1. */
  apply(record: JournalRecord, snapshot: boolean): void {
    if (this.closed) throw malformed('A record follows the closed record');
    if ((record.kind === 'segment') !== (this.owner === undefined))
      throw malformed('The segment record is not the first record of the segment');
    switch (record.kind) {
      case 'segment':
        this.owner = record.owner;
        this.clientId = record.clientId;
        this.broker = record.broker;
        this.epoch = record.epoch;
        this.established = record.established;
        this.nextSequence = record.nextSequence;
        break;
      case 'publication': {
        const { sequence, messageId } = record;
        if (this.publications.has(messageId) || this.releases.has(messageId))
          throw malformed('Publication record repeats a stored Packet Identifier');
        // A snapshot lists the stored publications, whose numbers have gaps. A later record takes the next number.
        if (snapshot ? sequence <= this.lastSnapshotSequence || sequence >= this.nextSequence : sequence !== this.nextSequence)
          throw malformed('Publication record is out of sequence');
        if (snapshot) this.lastSnapshotSequence = sequence;
        else this.nextSequence = sequence + 1;
        this.publications.set(messageId, { sequence, messageId, publication: record.publication });
        break;
      }
      case 'acknowledged':
      case 'withdrawn':
        this.publication(record.messageId);
        this.publications.delete(record.messageId);
        break;
      case 'received': {
        const { publication } = this.publication(record.messageId);
        if (publication.qos !== 2) throw malformed('Received record names a QoS 1 publication');
        this.publications.delete(record.messageId);
        this.releases.set(record.messageId, publication.topic);
        break;
      }
      case 'releasing':
        if (!snapshot || this.publications.has(record.messageId) || this.releases.has(record.messageId))
          throw malformed('Releasing record is outside the snapshot or repeats a stored Packet Identifier');
        this.releases.set(record.messageId, record.topic);
        break;
      case 'completed':
        if (!this.releases.delete(record.messageId)) throw malformed('Completed record names no release');
        break;
      case 'delivered':
        if (this.delivered.has(record.messageId)) throw malformed('Delivered record repeats a stored Packet Identifier');
        this.delivered.add(record.messageId);
        break;
      case 'released':
        if (!this.delivered.delete(record.messageId)) throw malformed('Released record names no delivery');
        break;
      case 'epoch':
        if (record.epoch !== this.epoch + 1) throw new Defect('epoch', 'Epoch record does not follow epoch ' + String(this.epoch));
        this.epoch = record.epoch;
        this.established = record.established;
        this.publications.clear();
        this.releases.clear();
        this.delivered.clear();
        this.requestedQos = 0;
        this.grantedQos = 0;
        this.subscribed = false;
        this.connection = undefined;
        break;
      case 'connected':
        if (this.connection !== undefined && this.connection.endedAt === undefined)
          throw malformed('Connected record follows a connection that has not ended');
        this.established = true;
        this.connection = { sessionExpiryInterval: record.sessionExpiryInterval, endedAt: undefined };
        break;
      case 'ended':
        if (this.connection === undefined || this.connection.endedAt !== undefined)
          throw malformed('Ended record follows no open connection');
        this.connection = { sessionExpiryInterval: this.connection.sessionExpiryInterval, endedAt: record.time };
        break;
      case 'fact':
        this.requestedQos = record.requestedQos;
        this.grantedQos = record.grantedQos;
        this.subscribed = record.subscribed;
        break;
      case 'closed':
        this.closed = true;
        break;
    }
  }

  state(): JournalState {
    const releases: StoredRelease[] = [];
    for (const [messageId, topic] of this.releases) releases.push({ messageId, topic });
    return {
      clientId: this.clientId,
      broker: this.broker,
      epoch: this.epoch,
      established: this.established,
      nextSequence: this.nextSequence,
      publications: [...this.publications.values()],
      releases,
      delivered: [...this.delivered],
      requestedQos: this.requestedQos,
      grantedQos: this.grantedQos,
      subscribed: this.subscribed,
      connection: this.connection,
      closed: this.closed,
    };
  }
}

/**
 * Read a segment and apply its records. The payload and the Correlation Data of a recovered publication are views of
 * `bytes`, so the caller keeps `bytes` unchanged while it uses the state.
 */
export function recoverSegment(bytes: ReadonlyBytes, generation: number): SegmentRecovery {
  const read = readSegment(bytes, generation);
  if (read.outcome !== 'read') return read;
  const replay = new Replay();
  let time = 0;
  for (const [index, frame] of read.frames.entries()) {
    try {
      if (frame.batch !== 1 && frame.epoch !== replay.epoch)
        throw new Defect('epoch', 'Frame of epoch ' + String(frame.epoch) + ' follows epoch ' + String(replay.epoch));
      for (const record of frame.records) {
        replay.apply(record, frame.batch === 1);
        if (record.kind === 'segment' && frame.epoch !== record.epoch)
          throw new Defect('epoch', 'Snapshot frame and segment record name different epochs');
      }
    } catch (error) {
      if (error instanceof Defect) return unreadable(error.reason, read.offsets[index] ?? segmentPrefixBytes, error.message);
      throw error;
    }
    ({ time } = frame);
  }
  const { owner } = replay;
  if (owner === undefined) return unreadable('record', segmentPrefixBytes, 'The segment record is missing');
  return {
    outcome: 'recovered',
    owner,
    state: replay.state(),
    batches: read.frames.length,
    time,
    tail: read.tail,
    bytes: read.bytes,
  };
}
