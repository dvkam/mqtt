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

const codec = { protocolVersion: 5 } as const;

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The core keeps native signals and Buffer payloads by identity.
function nodeClient(transport: ByteTransport, options: ByteClientOptions<Buffer>) {
  return createByteClient(transport, options, nodePlatform);
}

/** The broker side of a transport under test. */
type Peer = {
  transport: ByteTransport;
  received: string[];
  opens: () => number;
  /** Send a broker packet one byte per chunk. */
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- mqtt-packet generates from mutable packets.
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

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The script answers with mutable mqtt-packet packets.
type Script = (packet: Packet, peer: Peer) => void;

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The script answers with mutable mqtt-packet packets.
const broker: Script = (packet, peer) => {
  if (packet.cmd === 'connect') peer.send({ cmd: 'connack', reasonCode: 0, sessionPresent: false });
  if (packet.cmd === 'subscribe') peer.send({ cmd: 'suback', messageId: packet.messageId, granted: [0] });
  if (packet.cmd === 'pingreq') peer.send({ cmd: 'pingresp' });
};

/** A transport held in memory. Its writer exposes `bufferedBytes` and `frameOverhead` for the budget cases. */
function memoryPeer(script: Script = broker) {
  const decoder = parser(codec);
  let inbound: ByteInbound | undefined;
  let opens = 0;
  const writer = {
    bufferedBytes: 0,
    frameOverhead: undefined as ((length: number) => number) | undefined,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- The writer receives the encoded bytes by identity and consumes them before its promise settles.
    async write(chunk: Uint8Array) {
      decoder.parse(Buffer.from(chunk));
    },
    // oxlint-disable-next-line typescript/require-await -- The memory writer closes at once.
    async close(force: boolean) {
      peer.closes.push(force);
    },
  };
  const peer: Peer = {
    transport: {
      name: 'Memory',
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- The opener keeps the inbound object by identity and opens at once.
      async open(next) {
        opens++;
        inbound = next;
        return writer;
      },
    },
    received: [],
    opens: () => opens,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- mqtt-packet generates from mutable packets.
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
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- mqtt-packet emits mutable packets.
  decoder.on('packet', (packet: Packet) => {
    peer.received.push(packet.cmd);
    script(packet, peer);
  });
  return { peer, writer };
}

/** Adapt a Node Duplex to the byte transport contract. */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The adapter keeps the native stream and the inbound object by identity.
function adaptDuplex(stream: Duplex, inbound: ByteInbound, closes: boolean[]): ByteWriter {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The stream delivers native Buffers.
  stream.on('data', (chunk: Buffer) => {
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
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The stream keeps the encoded bytes by identity.
    async write(chunk) {
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
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- The opener keeps the inbound object by identity and the stream is open already.
      async open(inbound) {
        opens++;
        return adaptDuplex(client, inbound, peer.closes);
      },
    },
    received: [],
    opens: () => opens,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- mqtt-packet generates from mutable packets.
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
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The stream delivers native Buffers.
  server.on('data', (chunk: Buffer) => {
    decoder.parse(chunk);
  });
  server.on('end', () => {
    server.end();
  });
  server.on('error', () => {});
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- mqtt-packet emits mutable packets.
  decoder.on('packet', (packet: Packet) => {
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
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The core keeps native signals and payload views by identity.
  const connectWith = (transport: ByteTransport, options: ByteClientOptions) => createByteClient(transport, options, platform);

  test('connects, receives a publication split into single bytes and disconnects gracefully', async () => {
    const peer = makePeer();
    const messages: string[] = [];
    const payloadsAreBuffers: boolean[] = [];
    const client = await connectWith(peer.transport, {
      clientId: 'conformance',
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Messages carry mutable Buffer payloads.
      onMessage(message) {
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
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The script answers with mutable mqtt-packet packets.
  const refusing: Script = (packet, peer) => {
    if (packet.cmd === 'connect') peer.send({ cmd: 'connack', reasonCode: 0x87, sessionPresent: false });
  };

  test('force-closes the transport and releases the abort listener when the broker refuses the connection', async () => {
    const { peer } = memoryPeer(refusing);
    const controller = new AbortController();
    await expect(nodeClient(peer.transport, { clientId: 'refused', signal: controller.signal }).connect()).rejects.toMatchObject({
      message: 'MQTT acknowledgment refused',
      code: 0x87,
    });
    expect(peer.closes).toContain(true);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  test('keeps the refusal as the outcome when the writer close rejects', async () => {
    const { peer, writer } = memoryPeer(refusing);
    // oxlint-disable-next-line typescript/require-await -- The close fails as an async function would, by rejecting.
    writer.close = async () => {
      throw new Error('close rejected');
    };
    await expect(nodeClient(peer.transport, { clientId: 'refused' }).connect()).rejects.toMatchObject({
      message: 'MQTT acknowledgment refused',
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
    expect(peer.closes).toContain(true);
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
    // oxlint-disable-next-line typescript/require-await -- The writer fails as an async function would, by rejecting.
    writer.write = async () => {
      throw failure;
    };
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

describe('the core and shared subscriptions', () => {
  test('refuses a $share/ filter and writes nothing when the transport does not support it', async () => {
    const { peer } = memoryPeer();
    const client = await createByteClient(
      { ...peer.transport, supportsSharedSubscriptions: false },
      { clientId: 'no-share' },
      nodePlatform,
    ).connect();
    await expect(client.subscribe('$share/g/t')).rejects.toThrow('Unsupported shared subscription');
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
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The opener keeps the inbound object and the native abort signal by identity.
  function scriptedTransport(open: (inbound: ByteInbound, context: OpenContext) => Promise<ByteWriter>) {
    const calls: OpenContext[] = [];
    const transport: ByteTransport = {
      name: 'Scripted',
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The opener keeps the inbound object and the native abort signal by identity.
      async open(inbound, context) {
        calls.push(context);
        return open(inbound, context);
      },
    };
    return { transport, calls };
  }

  test('does not open the transport when the caller aborted already', async () => {
    // oxlint-disable-next-line typescript/require-await -- The opener fails as an async function would, by rejecting.
    const { transport, calls } = scriptedTransport(async () => {
      throw new Error('not reached');
    });
    const reason = new Error('aborted first');
    await expect(nodeClient(transport, { clientId: 'open', signal: AbortSignal.abort(reason) }).connect()).rejects.toBe(reason);
    expect(calls).toEqual([]);
  });

  test('aborts the open when the caller aborts, and rejects with the caller reason', async () => {
    const { transport, calls } = scriptedTransport(
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The opener keeps the native abort signal by identity.
      async (_inbound, context) =>
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
    // oxlint-disable-next-line typescript/require-await -- The opener fails as an async function would, by rejecting.
    const { transport, calls } = scriptedTransport(async () => {
      throw new Error('refused');
    });
    await expect(nodeClient(transport, { clientId: 'open', timeoutMs: 1234 }).connect()).rejects.toThrow('refused');
    expect(calls[0]?.timeoutMs).toBe(1234);
  });

  test('removes its abort listener when the open rejects', async () => {
    // oxlint-disable-next-line typescript/require-await -- The opener fails as an async function would, by rejecting.
    const { transport } = scriptedTransport(async () => {
      throw new Error('refused');
    });
    const controller = new AbortController();
    await expect(nodeClient(transport, { clientId: 'open', signal: controller.signal }).connect()).rejects.toThrow('refused');
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  test('rejects with the first failure the transport delivered before its open rejected', async () => {
    const failure = new Error('handshake broke');
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- The opener keeps the inbound object by identity and settles at once.
    const { transport } = scriptedTransport(async (inbound) => {
      inbound.fail(failure);
      inbound.end(new Error('closed after the failure'));
      throw new Error('socket closed before connecting');
    });
    const controller = new AbortController();
    await expect(nodeClient(transport, { clientId: 'open', signal: controller.signal }).connect()).rejects.toBe(failure);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  });

  test('closes a writer that arrives after the transport already ended', async () => {
    const close = vi.fn<(force: boolean) => Promise<void>>(async () => {});
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The writer receives the encoded bytes by identity.
    const write = vi.fn<(chunk: Uint8Array) => Promise<void>>(async () => {});
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- The opener keeps the inbound object by identity and settles at once.
    const { transport } = scriptedTransport(async (inbound) => {
      inbound.end(new Error('ended while opening'));
      return { bufferedBytes: 0, write, close };
    });
    await expect(nodeClient(transport, { clientId: 'open' }).connect()).rejects.toThrow('ended while opening');
    expect(close).toHaveBeenCalledWith(true);
    expect(write).not.toHaveBeenCalled();
  });

  test('rejects with invalid input the transport delivered while it opened', async () => {
    const close = vi.fn<(force: boolean) => Promise<void>>(async () => {});
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- The opener keeps the inbound object by identity and settles at once.
    const { transport, calls } = scriptedTransport(async (inbound) => {
      inbound.bytes(Uint8Array.of(0x21));
      return { bufferedBytes: 0, write: async () => {}, close };
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
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Pass the same native inbound endpoint and signal to the scripted peer.
        async open(inbound, context) {
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
