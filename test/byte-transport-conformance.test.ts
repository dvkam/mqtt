import { fileURLToPath } from 'node:url';
import { getEventListeners } from 'node:events';
import { duplexPair, type Duplex } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { generate, parser, type Packet } from 'mqtt-packet';
import { build, normalizePath } from 'vite';
import { describe, expect, test, vi } from 'vitest';
import type { ByteInbound, ByteTransport, ByteWriter, OpenContext } from '../src/byteTransport.js';
import type { SessionEnd } from '../src/session.js';
import type { BytePlatform } from '../src/bytePlatform.js';
import { nodePlatform } from '../src/nodePlatform.js';
import { portablePlatform } from '../src/portablePlatform.js';
import { createByteClient, type ByteClientOptions } from '../src/transportCore.js';
import { createTransportClient } from '../src/index.js';
import type { ClientSession } from '../src/session.js';
import type { PublishMessage } from '../src/messageProperties.js';
import type { ReadonlyBytes, ReadonlyDeep } from '../src/util/bytes.js';

const codec = { protocolVersion: 5 } as const;

function nodeClient(transport: Readonly<ByteTransport>, options: ReadonlyDeep<ByteClientOptions<Buffer>>) {
  return createByteClient(transport, options, nodePlatform);
}

/** The broker side of a transport under test. */
type Peer = {
  transport: ByteTransport;
  received: string[];
  opens: () => number;
  /** Send a broker packet one byte per chunk. */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. Each implementation of `send` hands `packet` to `generate` of mqtt-packet, which declares the writable `Packet`. `ReadonlyDeep<Packet>` is not assignable to it (TS2345), so the fixture would have to copy the packet first.
  send(packet: Packet): void;
  /** The broker finishes sending. */
  end(): void;
  /** Break the transport. */
  fail(error: Readonly<Error>): void;
  /** Close the connection without an end or an error first. */
  close(): void;
  /** The force flag of each close the core requested. */
  closes: boolean[];
};

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. A script calls `send` on `peer`, which writes the broker's reply to the transport under test. The rule accepts only a read-only type, and that would be false for this parameter.
type Script = (packet: ReadonlyDeep<Packet>, peer: Peer) => void;

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. The script calls `send` on `peer`, which writes the broker's reply to the transport under test. The rule accepts only a read-only type, and that would be false for this parameter.
const broker: Script = (packet: ReadonlyDeep<Packet>, peer) => {
  if (packet.cmd === 'connect') peer.send({ cmd: 'connack', reasonCode: 0, sessionPresent: false });
  if (packet.cmd === 'subscribe') peer.send({ cmd: 'suback', messageId: packet.messageId, granted: [0] });
  if (packet.cmd === 'pingreq') peer.send({ cmd: 'pingresp' });
};

/** The memory writer. Its members are writable so that a case can replace one. */
type MemoryWriter = {
  bufferedBytes: number;
  frameOverhead: ((length: number) => number) | undefined;
  write: ByteWriter['write'];
  close: ByteWriter['close'];
};

/** A transport held in memory. Its writer exposes `bufferedBytes` and `frameOverhead` for the budget cases. */
function memoryPeer(script: Script = broker) {
  const decoder = parser(codec);
  let inbound: ByteInbound | undefined;
  let opens = 0;
  const writer: MemoryWriter = {
    bufferedBytes: 0,
    frameOverhead: undefined,
    async write(chunk: ReadonlyBytes) {
      decoder.parse(Buffer.from(chunk));
      return Promise.resolve();
    },
    async close(force) {
      peer.closes.push(force);
      return Promise.resolve();
    },
  };
  const peer: Peer = {
    transport: {
      name: 'Memory',
      async open(next: Readonly<ByteInbound>) {
        opens++;
        inbound = next;
        return Promise.resolve(writer);
      },
    },
    received: [],
    opens: () => opens,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `packet` is handed to `generate` of mqtt-packet, which declares the writable `Packet`. `ReadonlyDeep<Packet>` is not assignable to it (TS2345), so the fixture would have to copy the packet first.
    send(packet) {
      // Deliver after the write that caused the reply has returned, as a socket would.
      const bytes = generate(packet, codec);
      void setImmediate().then(() => {
        for (const byte of bytes) inbound?.bytes(Uint8Array.of(byte));
      });
    },
    end() {
      inbound?.end(new Error('Memory ended'));
    },
    fail(error) {
      inbound?.fail(error);
    },
    close() {
      inbound?.end();
    },
    closes: [],
  };
  decoder.on('packet', (packet: ReadonlyDeep<Packet>) => {
    peer.received.push(packet.cmd);
    script(packet, peer);
  });
  return { peer, writer };
}

/** Adapt a Node Duplex to the byte transport contract. */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. The returned writer pushes the force flag of each close onto `closes`, which is how a case reads what the core requested, and the rule accepts no parameter that is written. The helper would have to return the list and every caller would have to merge it into its `Peer`. Removing it would cost developer experience. The adapter calls `end`, `destroy` and `write` on `stream`. It writes the client's bytes to the stream and destroys the stream on a forced close, which is what the conformance cases observe. The rule accepts only a read-only type, and that would be false for this parameter.
function adaptDuplex(stream: Duplex, inbound: Readonly<ByteInbound>, closes: boolean[]): ByteWriter {
  stream.on('data', (chunk: Readonly<Buffer<Readonly<ArrayBufferLike>>>) => {
    inbound.bytes(chunk);
  });
  stream.on('end', () => {
    inbound.end(new Error('Duplex ended'));
  });
  stream.on('error', (error: Readonly<Error>) => {
    inbound.fail(error);
  });
  const closed = new Promise<void>((resolve) => {
    stream.once('close', () => {
      try {
        inbound.end(new Error('Duplex closed'));
      } finally {
        resolve();
      }
    });
  });
  return {
    get bufferedBytes() {
      return stream.writableLength;
    },
    async write(chunk: ReadonlyBytes) {
      return new Promise((resolve, reject) => {
        stream.write(chunk, (error?: Readonly<Error> | null) => {
          error ? reject(error) : resolve();
        });
      });
    },
    async close(force) {
      closes.push(force);
      if (force) stream.destroy();
      else stream.end();
      await closed;
    },
  };
}

function duplexPeer(script: Script = broker) {
  const [client, server] = duplexPair();
  const decoder = parser(codec);
  let opens = 0;
  const peer: Peer = {
    transport: {
      name: 'Duplex',
      async open(inbound: Readonly<ByteInbound>) {
        opens++;
        return Promise.resolve(adaptDuplex(client, inbound, peer.closes));
      },
    },
    received: [],
    opens: () => opens,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `packet` is handed to `generate` of mqtt-packet, which declares the writable `Packet`. `ReadonlyDeep<Packet>` is not assignable to it (TS2345), so the fixture would have to copy the packet first.
    send(packet) {
      for (const byte of generate(packet, codec)) server.write(Buffer.of(byte));
    },
    end() {
      server.end();
    },
    fail(error) {
      client.destroy(error);
    },
    close() {
      client.destroy();
    },
    closes: [],
  };
  server.on('data', (chunk: Readonly<Buffer<Readonly<ArrayBufferLike>>>) => {
    decoder.parse(chunk);
  });
  server.on('end', () => {
    server.end();
  });
  server.on('error', () => {});
  decoder.on('packet', (packet: ReadonlyDeep<Packet>) => {
    peer.received.push(packet.cmd);
    script(packet, peer);
  });
  return { peer };
}

function sessionEnd() {
  let resolve: (event: SessionEnd) => void = () => {};
  const ended = new Promise<SessionEnd>((settle) => {
    resolve = settle;
  });
  const onSessionEnd = vi.fn<(event: SessionEnd) => void>((event) => {
    resolve(event);
  });
  return { ended, onSessionEnd };
}

function endError(event: SessionEnd): Readonly<Error> {
  if (event.kind !== 'error') throw new Error('Expected the session to end with an error');
  return event.error;
}

const platforms: ReadonlyArray<readonly [string, (script?: Script) => Peer, BytePlatform<Uint8Array>, boolean]> = [
  ['an in-memory transport', (script) => memoryPeer(script).peer, nodePlatform, true],
  ['a Node Duplex', (script) => duplexPeer(script).peer, nodePlatform, true],
  ['an in-memory transport with plain Uint8Array payloads', (script) => memoryPeer(script).peer, portablePlatform, false],
];

describe.each(platforms)('the core over %s', (_name, makePeer, platform, buffers) => {
  const connectWith = (transport: Readonly<ByteTransport>, options: ReadonlyDeep<ByteClientOptions>) =>
    createByteClient(transport, options, platform);

  test('connects, receives a publication split into single bytes and disconnects gracefully', async () => {
    const peer = makePeer();
    const messages: string[] = [];
    const payloadsAreBuffers: boolean[] = [];
    const client = await connectWith(peer.transport, {
      clientId: 'conformance',
      onMessage(message: ReadonlyDeep<PublishMessage>) {
        messages.push(message.topic + '=' + Buffer.from(message.payload).toString());
        payloadsAreBuffers.push(Buffer.isBuffer(message.payload));
      },
    }).connect();
    await client.subscribe('t');
    peer.send({ cmd: 'publish', topic: 't', payload: 'hi', qos: 0, dup: false, retain: false });
    await vi.waitFor(() => {
      expect(messages).toEqual(['t=hi']);
    });
    expect(payloadsAreBuffers).toEqual([buffers]);
    await client.disconnect();
    expect(peer.received).toEqual(['connect', 'subscribe', 'disconnect']);
    expect(peer.closes).toEqual([false]);
  });

  test('ends the session with the reason the transport gives when the peer ends', async () => {
    const peer = makePeer();
    const controller = new AbortController();
    const { ended, onSessionEnd } = sessionEnd();
    const client = await connectWith(peer.transport, {
      clientId: 'conformance',
      signal: controller.signal,
      onSessionEnd,
    }).connect();
    peer.end();
    const error = endError(await ended);
    expect(error.message).toMatch(/ended$/u);
    await expect(client.ping()).rejects.toBe(error);
    expect(peer.closes).toContain(true);
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  test('ends the session when the connection closes without an end or an error', async () => {
    const peer = makePeer();
    const { ended, onSessionEnd } = sessionEnd();
    const client = await connectWith(peer.transport, { clientId: 'conformance', onSessionEnd }).connect();
    peer.close();
    const error = endError(await ended);
    expect(error.message).toMatch(/closed$/u);
    await expect(client.ping()).rejects.toBe(error);
  });

  test('ends the session with the transport failure', async () => {
    const peer = makePeer();
    const controller = new AbortController();
    const { ended, onSessionEnd } = sessionEnd();
    await connectWith(peer.transport, { clientId: 'conformance', signal: controller.signal, onSessionEnd }).connect();
    const failure = new Error('transport broke');
    peer.fail(failure);
    expect(endError(await ended)).toBe(failure);
    expect(peer.closes).toContain(true);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  test('answers AUTH with DISCONNECT 0x82 and closes the transport', async () => {
    const peer = makePeer();
    const { ended, onSessionEnd } = sessionEnd();
    await connectWith(peer.transport, { clientId: 'conformance', onSessionEnd }).connect();
    peer.send({ cmd: 'auth', reasonCode: 0x18 });
    expect(endError(await ended).message).toBe('Unexpected MQTT AUTH');
    await vi.waitFor(() => {
      expect(peer.received).toEqual(['connect', 'disconnect']);
      expect(peer.closes.length).toBeGreaterThan(0);
    });
  });

  test('ends the session when a packet exceeds the packet limit', async () => {
    const peer = makePeer();
    const { ended, onSessionEnd } = sessionEnd();
    await connectWith(peer.transport, { clientId: 'conformance', maxPacketBytes: 16, onSessionEnd }).connect();
    peer.send({ cmd: 'publish', topic: 't', payload: 'x'.repeat(32), qos: 0, dup: false, retain: false });
    expect(endError(await ended).message).toBe('MQTT packet allocation limit exceeded');
    expect(peer.closes).toContain(true);
  });

  test('force-closes the transport and ends the session when the caller aborts', async () => {
    const peer = makePeer();
    const controller = new AbortController();
    const { ended, onSessionEnd } = sessionEnd();
    const client = await connectWith(peer.transport, {
      clientId: 'conformance',
      signal: controller.signal,
      onSessionEnd,
    }).connect();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    const reason = new Error('caller gave up');
    controller.abort(reason);
    expect(endError(await ended)).toBe(reason);
    await expect(client.ping()).rejects.toBe(reason);
    expect(peer.closes[0]).toBe(true);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });
});

describe('the core over a transport that controls its write budget', () => {
  const options: ByteClientOptions<Buffer> = { clientId: 'budget', maxBufferedBytes: 1000, reservedControlBytes: 200 };

  test('refuses a publication beyond the budget and keeps the session usable for control packets', async () => {
    const { peer, writer } = memoryPeer();
    const client = await nodeClient(peer.transport, options).connect();
    writer.bufferedBytes = 800;
    await expect(client.publish('t', 'x')).rejects.toThrow('Memory write budget exceeded');
    await client.ping();
    expect(peer.received).toEqual(['connect', 'pingreq']);
  });

  test('refuses a QoS 1 publication beyond the budget without ending the session', async () => {
    const { peer, writer } = memoryPeer();
    const { onSessionEnd } = sessionEnd();
    const client = await nodeClient(peer.transport, { ...options, onSessionEnd }).connect();
    writer.bufferedBytes = 800;
    await expect(client.publish('t', 'x', { qos: 1 })).rejects.toThrow('Memory write budget exceeded');
    await client.ping();
    expect(onSessionEnd).not.toHaveBeenCalled();
  });

  test('counts the frame overhead the writer reports', async () => {
    const { peer, writer } = memoryPeer();
    const client = await nodeClient(peer.transport, options).connect();
    writer.frameOverhead = () => 800;
    await expect(client.publish('t', 'x')).rejects.toThrow('Memory write budget exceeded');
    writer.frameOverhead = () => 0;
    await client.publish('t', 'x');
    expect(peer.received).toEqual(['connect', 'publish']);
  });
});

describe('the core over a transport it closes', () => {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. The script calls `send` on `peer`, which writes the broker's reply to the transport under test. The rule accepts only a read-only type, and that would be false for this parameter.
  const refusing: Script = (packet: ReadonlyDeep<Packet>, peer) => {
    if (packet.cmd === 'connect') peer.send({ cmd: 'connack', reasonCode: 0x87, sessionPresent: false });
  };

  test('force-closes the transport and releases the abort listener when the broker refuses the connection', async () => {
    const { peer } = memoryPeer(refusing);
    const controller = new AbortController();
    await expect(nodeClient(peer.transport, { clientId: 'refused', signal: controller.signal }).connect()).rejects.toMatchObject({
      message: 'MQTT acknowledgment refused',
      code: 'ERR_MQTT_REFUSED',
      reasonCode: 0x87,
    });
    expect(peer.closes).toEqual([true]);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  test('keeps the refusal as the outcome when the writer close rejects', async () => {
    const { peer, writer } = memoryPeer(refusing);
    writer.close = async () => Promise.reject(new Error('close rejected'));
    await expect(nodeClient(peer.transport, { clientId: 'refused' }).connect()).rejects.toMatchObject({
      message: 'MQTT acknowledgment refused',
      code: 'ERR_MQTT_REFUSED',
      reasonCode: 0x87,
    });
  });

  test('releases the abort listener when the session force-closes after a protocol error', async () => {
    const { peer } = memoryPeer();
    const controller = new AbortController();
    const { ended, onSessionEnd } = sessionEnd();
    await nodeClient(peer.transport, { clientId: 'auth', signal: controller.signal, onSessionEnd }).connect();
    peer.send({ cmd: 'auth', reasonCode: 0x18 });
    await ended;
    await vi.waitFor(() => {
      expect(peer.closes).toEqual([true]);
    });
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  test('rejects the connect when the caller aborts as the session becomes active', async () => {
    const { peer } = memoryPeer();
    const controller = new AbortController();
    const reason = new Error('aborted on CONNACK');
    const connecting = nodeClient(peer.transport, {
      clientId: 'late-abort',
      signal: controller.signal,
      onDiagnostic(event) {
        if (event.kind === 'connection' && event.state === 'active') controller.abort(reason);
      },
    }).connect();
    await expect(connecting).rejects.toBe(reason);
    expect(peer.closes).toEqual([true]);
  });

  test('joins transport failure and disconnect on one forced close', async () => {
    const { peer, writer } = memoryPeer();
    const controller = new AbortController();
    const { ended, onSessionEnd } = sessionEnd();
    const client = await nodeClient(peer.transport, {
      clientId: 'write-during-close',
      signal: controller.signal,
      onSessionEnd,
    }).connect();
    let releaseClose = () => {};
    const closed = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const close = writer.close.bind(writer);
    writer.write = async (bytes: ReadonlyBytes) => {
      expect(bytes[0]).toBe(0xe0);
      await closed;
    };
    writer.close = async (force) => {
      await close(force);
      await closed;
    };
    const failure = new Error('transport failed during disconnect');
    const disconnecting = client.disconnect();
    const disconnected = vi.fn<(reason: unknown) => void>();
    const outcome = disconnecting.catch(disconnected);
    try {
      await setImmediate();
      peer.fail(failure);
      peer.fail(new Error('later failure'));
      controller.abort(new Error('later cancellation'));
      await setImmediate();
      expect(disconnected).not.toHaveBeenCalled();
      expect(endError(await ended)).toBe(failure);
      expect(peer.closes).toEqual([true]);
    } finally {
      releaseClose();
      await outcome;
    }
    expect(disconnected).toHaveBeenCalledExactlyOnceWith(failure);
  });

  test('writes nothing once the transport ended', async () => {
    const { peer, writer } = memoryPeer();
    const client = await nodeClient(peer.transport, { clientId: 'ended' }).connect();
    const write = vi.spyOn(writer, 'write');
    peer.end();
    await expect(client.publish('t', 'x')).rejects.toThrow('Memory ended');
    expect(write).not.toHaveBeenCalled();
  });

  test('rejects a publication with the error of a failed write', async () => {
    const { peer, writer } = memoryPeer();
    const client = await nodeClient(peer.transport, { clientId: 'write-failure' }).connect();
    const failure = new Error('write failed');
    writer.write = async () => Promise.reject(failure);
    await expect(client.publish('t', 'x')).rejects.toBe(failure);
  });

  test('keeps a synchronous throw from the writer close inside the core', async () => {
    const { peer, writer } = memoryPeer();
    const { ended, onSessionEnd } = sessionEnd();
    await nodeClient(peer.transport, { clientId: 'close-throws', onSessionEnd }).connect();
    writer.close = () => {
      throw new Error('close threw');
    };
    expect(() => {
      peer.end();
    }).not.toThrow();
    expect(endError(await ended).message).toBe('Memory ended');
  });

  test('force-closes the transport when it fails after a graceful close, and keeps the disconnect', async () => {
    const { peer } = memoryPeer();
    const { ended, onSessionEnd } = sessionEnd();
    const client = await nodeClient(peer.transport, { clientId: 'graceful-failure', onSessionEnd }).connect();
    await client.disconnect();
    peer.fail(new Error('broke while closing'));
    expect(peer.closes).toEqual([false, true]);
    await expect(ended).resolves.toEqual({ kind: 'disconnect' });
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });

  test('does not force-close after a graceful close when the peer then ends', async () => {
    const { peer } = memoryPeer();
    const controller = new AbortController();
    const client = await nodeClient(peer.transport, { clientId: 'graceful', signal: controller.signal }).connect();
    await client.disconnect();
    // The graceful close settled, so the caller's signal is released.
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    peer.end();
    expect(peer.closes).toEqual([false]);
  });
});

test.each([
  { name: 'over 65,535 bytes', password: (): unknown => new Uint8Array(65_536), message: 'MQTT password exceeds 65,535 bytes' },
  { name: 'of an unsupported type', password: (): unknown => 42, message: 'MQTT password must be a string or a Uint8Array' },
] as const)('rejects a password $name before opening the transport', async ({ password: make, message }) => {
  const password = make();
  const { peer } = memoryPeer();
  const options: Record<string, unknown> = { password };
  const factory = createTransportClient(peer.transport, { clientId: 'invalid-password', ...options });
  await expect(factory.connect()).rejects.toMatchObject({ message, code: 'ERR_MQTT_INVALID_ARGUMENT', fatal: false });
  expect(peer.opens()).toBe(0);
});

test('checks the copied password length, not a byteLength getter that a subclass overrides', async () => {
  class ShortLookingBytes extends Uint8Array {
    override get byteLength(): number {
      return 1;
    }
  }
  const { peer } = memoryPeer();
  const factory = createTransportClient(peer.transport, { clientId: 'subclass-password', password: new ShortLookingBytes(70_000) });
  await expect(factory.connect()).rejects.toMatchObject({
    code: 'ERR_MQTT_INVALID_ARGUMENT',
    message: 'MQTT password exceeds 65,535 bytes',
  });
  expect(peer.opens()).toBe(0);
});

test('rejects an invalid Will topic before opening the transport', async () => {
  const { peer } = memoryPeer();
  const factory = createTransportClient(peer.transport, {
    clientId: 'invalid-will',
    will: { topic: 'status/+', payload: 'offline' },
  });
  await expect(factory.connect()).rejects.toMatchObject({
    message: 'Invalid MQTT Will topic',
    code: 'ERR_MQTT_INVALID_ARGUMENT',
  });
  expect(peer.opens()).toBe(0);
});

test.each([
  ['a Content Type over 65,535 bytes', { contentType: 'c'.repeat(70_000) }, 'Invalid MQTT Will Content Type'],
  ['a Content Type with U+0000', { contentType: 'a\u0000b' }, 'Invalid MQTT Will Content Type'],
  ['a User Property key over 65,535 bytes', { userProperties: [['k'.repeat(70_000), 'v']] }, 'Invalid MQTT Will User Property'],
  ['a User Property value with an unpaired surrogate', { userProperties: [['k', '\uD800']] }, 'Invalid MQTT Will User Property'],
] as const)('rejects a Will with %s before opening the transport', async (_name, fields, message) => {
  const { peer } = memoryPeer();
  const factory = createTransportClient(peer.transport, {
    clientId: 'invalid-will-string',
    will: { topic: 'status/a', payload: 'offline', ...fields },
  });
  await expect(factory.connect()).rejects.toMatchObject({ message, code: 'ERR_MQTT_INVALID_ARGUMENT' });
  expect(peer.opens()).toBe(0);
});

test('the packet limit getter can abort without opening, sending CONNECT, or delivering input', async () => {
  const { peer } = memoryPeer();
  const controller = new AbortController();
  const error = new Error('aborted while reading the packet limit');
  const factory = createTransportClient(peer.transport, {
    clientId: 'pre-open-abort',
    signal: controller.signal,
    get maxPacketBytes() {
      controller.abort(error);
      return 4096;
    },
  });
  await expect(factory.connect()).rejects.toBe(error);
  expect(peer.opens()).toBe(0);
  expect(peer.received).toEqual([]);
});

test('captures Will bytes and user properties before opening the transport', async () => {
  const packets: ReadonlyDeep<Packet>[] = [];
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. The script hands `target` to `broker`, which calls `send` on it to write the broker's reply to the transport under test. The rule accepts only a read-only type, and that would be false for this parameter.
  const { peer } = memoryPeer((packet, target) => {
    packets.push(packet);
    broker(packet, target);
  });
  const payload = Uint8Array.of(0, 255);
  const correlationData = Uint8Array.of(7);
  const userProperties: [string, string][] = [['origin', 'original']];
  const transport: ByteTransport = {
    ...peer.transport,
    async open(inbound: Readonly<ByteInbound>, context: ReadonlyDeep<OpenContext>) {
      payload.fill(4);
      correlationData.fill(5);
      userProperties[0]![1] = 'changed';
      return peer.transport.open(inbound, context);
    },
  };
  const factory = createTransportClient(transport, {
    clientId: 'will-snapshot',
    will: { topic: 'status/a', payload, qos: 1, retain: true, correlationData, userProperties },
  });
  await (await factory.connect()).disconnect();
  expect(packets[0]).toMatchObject({
    cmd: 'connect',
    will: {
      topic: 'status/a',
      payload: Buffer.from([0, 255]),
      qos: 1,
      retain: true,
      properties: { correlationData: Buffer.from([7]), userProperties: { origin: 'original' } },
    },
  });
});

test.each([
  [0x9a, 'MQTT broker does not support a retained Will'],
  [0x9b, 'MQTT broker does not support the requested Will QoS'],
] as const)('keeps Will refusal %s as the opening error', async (code, message) => {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. The script calls `send` on `target`, which writes the broker's reply to the transport under test. The rule accepts only a read-only type, and that would be false for this parameter.
  const { peer } = memoryPeer((packet: ReadonlyDeep<Packet>, target) => {
    if (packet.cmd === 'connect') target.send({ cmd: 'connack', reasonCode: code, sessionPresent: false });
  });
  const { ended, onSessionEnd } = sessionEnd();
  const result = createTransportClient(peer.transport, {
    clientId: 'will-refused',
    will: { topic: 'status/a', payload: 'offline', qos: 1, retain: true },
    onSessionEnd,
  }).connect();
  await expect(result).rejects.toMatchObject({ code: 'ERR_MQTT_REFUSED', reasonCode: code, message });
  await expect(result).rejects.toBe(endError(await ended));
  expect(peer.closes).toEqual([true]);
});

describe('the core and shared subscriptions', () => {
  test('refuses a $share/ filter and writes nothing when the transport does not support it', async () => {
    const { peer } = memoryPeer();
    const client = await createByteClient(
      { ...peer.transport, supportsSharedSubscriptions: false },
      { clientId: 'no-share' },
      nodePlatform,
    ).connect();
    await expect(client.subscribe('$share/g/t')).rejects.toMatchObject({
      message: 'Unsupported shared subscription',
      code: 'ERR_MQTT_INVALID_ARGUMENT',
    });
    // The session refuses the filter itself, so the refusal does not end it.
    await client.ping();
    expect(peer.received).toEqual(['connect', 'pingreq']);
  });

  test('encodes and sends a $share/ filter by default', async () => {
    const { peer } = memoryPeer();
    const client = await nodeClient(peer.transport, { clientId: 'share' }).connect();
    await client.subscribe('$share/g/t');
    expect(peer.received).toEqual(['connect', 'subscribe']);
  });
});

describe('the core and passwords', () => {
  test('sends no password for a transport that does not support one', async () => {
    const { peer, writer } = memoryPeer();
    const writes = vi.spyOn(writer, 'write');
    const credentials = { clientId: 'no-password', username: 'u', password: Uint8Array.of(1, 2) };
    await createByteClient({ ...peer.transport, supportsPassword: false }, credentials, nodePlatform).connect();
    // CONNECT flags: 0x80 is the username, 0x40 the password.
    const flags = writes.mock.calls[0]?.[0][9] ?? 0;
    expect({ username: (flags & 0x80) !== 0, password: (flags & 0x40) !== 0 }).toEqual({ username: true, password: false });
  });

  test('sends the password by default', async () => {
    const { peer, writer } = memoryPeer();
    const writes = vi.spyOn(writer, 'write');
    await nodeClient(peer.transport, { clientId: 'password', username: 'u', password: Uint8Array.of(1, 2) }).connect();
    const flags = writes.mock.calls[0]?.[0][9] ?? 0;
    expect((flags & 0x40) !== 0).toBe(true);
  });
});

describe('the core while it opens a transport', () => {
  function scriptedTransport(open: (inbound: Readonly<ByteInbound>, context: ReadonlyDeep<OpenContext>) => Promise<ByteWriter>) {
    const calls: ReadonlyDeep<OpenContext>[] = [];
    const transport: ByteTransport = {
      name: 'Scripted',
      async open(inbound: Readonly<ByteInbound>, context: ReadonlyDeep<OpenContext>) {
        calls.push(context);
        return open(inbound, context);
      },
    };
    return { transport, calls };
  }

  test('does not open the transport when the caller aborted already', async () => {
    const { transport, calls } = scriptedTransport(async () => Promise.reject(new Error('not reached')));
    const reason = new Error('aborted first');
    await expect(nodeClient(transport, { clientId: 'open', signal: AbortSignal.abort(reason) }).connect()).rejects.toBe(reason);
    expect(calls).toEqual([]);
  });

  test('aborts the open when the caller aborts, and rejects with the caller reason', async () => {
    const { transport, calls } = scriptedTransport(
      async (_inbound: Readonly<ByteInbound>, context: ReadonlyDeep<OpenContext>) =>
        new Promise<ByteWriter>((_resolve, reject) => {
          context.signal.addEventListener('abort', () => {
            reject(new Error('open cancelled'));
          });
        }),
    );
    const controller = new AbortController();
    const connecting = nodeClient(transport, { clientId: 'open', signal: controller.signal }).connect();
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    const reason = new Error('caller gave up');
    controller.abort(reason);
    await expect(connecting).rejects.toBe(reason);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  test('passes the operation timeout to the opener', async () => {
    const { transport, calls } = scriptedTransport(async () => Promise.reject(new Error('refused')));
    await expect(nodeClient(transport, { clientId: 'open', timeoutMs: 1234 }).connect()).rejects.toThrow('refused');
    expect(calls[0]?.timeoutMs).toBe(1234);
  });

  test('removes its abort listener when the open rejects', async () => {
    const { transport } = scriptedTransport(async () => Promise.reject(new Error('refused')));
    const controller = new AbortController();
    await expect(nodeClient(transport, { clientId: 'open', signal: controller.signal }).connect()).rejects.toThrow('refused');
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  test('rejects with the first failure the transport delivered before its open rejected', async () => {
    const failure = new Error('handshake broke');
    const { transport } = scriptedTransport(async (inbound: Readonly<ByteInbound>) => {
      inbound.fail(failure);
      inbound.end(new Error('closed after the failure'));
      return Promise.reject(new Error('socket closed before connecting'));
    });
    const controller = new AbortController();
    await expect(nodeClient(transport, { clientId: 'open', signal: controller.signal }).connect()).rejects.toBe(failure);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  test('closes a writer that arrives after the transport already ended', async () => {
    const close = vi.fn<(force: boolean) => Promise<void>>(async () => {});
    const write = vi.fn<(chunk: ReadonlyBytes) => Promise<void>>(async () => {});
    const { transport } = scriptedTransport(async (inbound: Readonly<ByteInbound>) => {
      inbound.end(new Error('ended while opening'));
      return Promise.resolve({ bufferedBytes: 0, write, close });
    });
    await expect(nodeClient(transport, { clientId: 'open' }).connect()).rejects.toThrow('ended while opening');
    expect(close).toHaveBeenCalledWith(true);
    expect(write).not.toHaveBeenCalled();
  });

  test('rejects with invalid input the transport delivered while it opened', async () => {
    const close = vi.fn<(force: boolean) => Promise<void>>(async () => {});
    const { transport, calls } = scriptedTransport(async (inbound: Readonly<ByteInbound>) => {
      inbound.bytes(Uint8Array.of(0x21));
      return Promise.resolve({ bufferedBytes: 0, write: async () => {}, close });
    });
    await expect(nodeClient(transport, { clientId: 'open' }).connect()).rejects.toThrow(
      'Invalid header flag bits, must be 0x0 for connack packet',
    );
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(close).toHaveBeenCalledWith(true);
  });

  test('opens once however often the factory connects', async () => {
    const { peer } = memoryPeer();
    const factory = nodeClient(peer.transport, { clientId: 'once' });
    const first = factory.connect();
    expect(factory.connect()).toBe(first);
    await first;
    expect(peer.opens()).toBe(1);
  });

  test('the public factory shares its connection with a synchronous call from open', async () => {
    const { peer } = memoryPeer();
    const secondPeer = memoryPeer().peer;
    let duringOpen: Promise<ClientSession> | undefined;
    let reentered = false;
    const factory = createTransportClient(
      {
        name: 'Reentrant transport',
        async open(inbound: Readonly<ByteInbound>, context: ReadonlyDeep<OpenContext>) {
          if (reentered) return secondPeer.transport.open(inbound, context);
          reentered = true;
          duringOpen = factory.connect();
          return peer.transport.open(inbound, context);
        },
      },
      { clientId: 'reentrant' },
    );
    const first = factory.connect();
    try {
      expect(duringOpen).toBe(first);
      expect(peer.opens()).toBe(1);
      expect(secondPeer.opens()).toBe(0);
    } finally {
      await (await first).disconnect();
      if (duringOpen && duringOpen !== first) await (await duringOpen).disconnect();
    }
  });

  test('rejects an invalid option before it opens the transport', async () => {
    const { peer } = memoryPeer();
    await expect(nodeClient(peer.transport, { clientId: 'invalid', maxPacketBytes: 1 }).connect()).rejects.toThrow(RangeError);
    expect(peer.opens()).toBe(0);
  });
});

// Bundle the core for a browser, as the packed browser check bundles the package, and scan what the bundler emits. This
// covers every import form, Node builtins without the node: prefix, and code inside strings.
test('a browser bundle of the transport core contains no Node API', async () => {
  // Vite reports module ids with forward slashes on every platform, and drive letters may differ in case on Windows.
  const sources = normalizePath(fileURLToPath(new URL('../src/', import.meta.url))).toLowerCase();
  const outside = (id: string) => !id.startsWith('\0') && !normalizePath(id).toLowerCase().startsWith(sources);
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: {
        entry: {
          core: fileURLToPath(new URL('../src/transportCore.ts', import.meta.url)),
          platform: fileURLToPath(new URL('../src/portablePlatform.ts', import.meta.url)),
        },
        formats: ['es'],
      },
    },
  });
  const chunks = [];
  for (const bundle of Array.isArray(result) ? result : [result]) {
    if (!('output' in bundle)) throw new Error('Unexpected Vite watcher');
    for (const output of bundle.output) if (output.type === 'chunk') chunks.push(output);
  }
  expect(chunks.length).toBeGreaterThan(0);
  for (const chunk of chunks) {
    expect({ chunk: chunk.fileName, external: chunk.imports.filter((name) => !name.endsWith('.js')) }).toEqual({
      chunk: chunk.fileName,
      external: [],
    });
    expect(chunk.dynamicImports).toEqual([]);
    // Only the package's own sources: a consumer has no polyfill such as the events package to bundle.
    expect(chunk.moduleIds.filter(outside)).toEqual([]);
    expect(chunk.code).not.toMatch(/__vite-browser-external|\bBuffer\b|\bnode:|\bprocess\b|\bsetImmediate\b|\brequire\(/u);
  }
  let code = '';
  for (const chunk of chunks) code += chunk.code;
  // The bundle must hold the framer and the session, so a broken entry cannot pass by being empty.
  expect(code).toContain('MQTT packet allocation limit exceeded');
  expect(code).toContain('Duplicate MQTT CONNACK');
});
