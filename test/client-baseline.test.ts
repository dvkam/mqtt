import { Duplex } from 'node:stream';
import { once } from 'node:events';
import { generate, parser, type Packet } from 'mqtt-packet';
import { expect, test, vi } from 'vitest';
import { connect } from '../src/index.js';

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
function peer(version: 4 | 5, reply?: Packet) {
  const packets: Packet[] = [];
  let blocked = false;
  const decoder = parser({ protocolVersion: version });
  const stream = new Duplex({
    writableHighWaterMark: 1,
    read() {},
    write(chunk, _encoding, callback) {
      if (blocked) return;
      const bytes: unknown = chunk;
      if (!Buffer.isBuffer(bytes)) throw new Error('Expected byte chunk');
      decoder.parse(bytes);
      callback();
    },
    final(callback) {
      this.push(null);
      callback();
    },
  });
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  decoder.on('packet', (packet: Packet) => {
    packets.push(packet);
    if (packet.cmd === 'connect' && reply) stream.push(generate(reply, { protocolVersion: version }));
  });
  const options = {
    brokerUrl: new URL('mqtt://localhost'),
    protocolVersion: version,
    connectTimeout: 100,
    customStreamFactory: () => stream,
  };
  return { options, packets, stream, block: () => (blocked = true) };
}

test.each([4, 5] as const)('writes one CONNECT, a QoS 0 publish, and DISCONNECT at protocol level %i', async (version) => {
  const { options, packets, stream } = peer(version, {
    cmd: 'connack',
    sessionPresent: false,
    ...(version === 5 ? { reasonCode: 0 } : { returnCode: 0 }),
  });
  try {
    const client = await connect({ ...options, clientId: 'baseline-client' });
    expect(packets[0]).toMatchObject({ cmd: 'connect', clientId: 'baseline-client', protocolVersion: version });
    await client.publish({ topic: 'baseline/topic', payload: 'hello' });
    const finished = once(stream, 'finish');
    await client.disconnect();
    await finished;

    expect(packets.map(({ cmd }: Readonly<{ cmd: string }>) => cmd)).toEqual(['connect', 'publish', 'disconnect']);
    expect(packets[1]).toMatchObject({ qos: 0, topic: 'baseline/topic', payload: Buffer.from('hello') });
    expect(packets[1]).not.toHaveProperty('messageId');
  } finally {
    stream.destroy();
  }
});

test('preserves the broker refusal code and closes the transport', async () => {
  const { options, stream } = peer(5, { cmd: 'connack', sessionPresent: false, reasonCode: 0x87 });
  try {
    await expect(connect(options)).rejects.toMatchObject({ code: 0x87, message: 'Connection refused: Not authorized' });
    expect(stream.destroyed).toBe(true);
  } finally {
    stream.destroy();
  }
});

test('rejects when CONNACK never arrives and closes the transport', async () => {
  const { options, stream } = peer(4);
  try {
    await expect(connect(options)).rejects.toThrow('connack packet timeout');
    expect(stream.destroyed).toBe(true);
  } finally {
    stream.destroy();
  }
});

test('legacy publish rejects when a blocked transport closes before drain', async () => {
  const { options, stream, block } = peer(5, { cmd: 'connack', sessionPresent: false, reasonCode: 0 });
  const client = await connect(options);
  block();
  const published = client.publish({ topic: 'baseline/topic', payload: 'hello' });
  stream.destroy();
  await expect(published).rejects.toThrow('Transport closed before drain');
  expect(stream.listenerCount('drain')).toBe(0);
}, 500);

test('never serializes CONNECT credentials or PUBLISH payloads for logging', async () => {
  const { options, stream } = peer(5, { cmd: 'connack', sessionPresent: false, reasonCode: 0 });
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    const client = await connect({ ...options, username: 'test-secret', password: Buffer.from('test-password') });
    await client.publish({ topic: 'baseline/topic', payload: 'test-payload' });
    await client.disconnect();
    const serializedPackets = stringify.mock.calls
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
      .map(([value]): unknown => value)
      .filter((value) => typeof value === 'object' && value !== null && 'cmd' in value);
    expect(serializedPackets).toEqual([]);
  } finally {
    stringify.mockRestore();
    stream.destroy();
  }
});

test('retains the legacy default CONNECT fields without an embedded broker', async () => {
  const { options, packets, stream } = peer(4, { cmd: 'connack', sessionPresent: false, returnCode: 0 });
  try {
    const client = await connect({ brokerUrl: options.brokerUrl, customStreamFactory: options.customStreamFactory });
    expect(packets[0]).toMatchObject({
      cmd: 'connect',
      protocolId: 'MQTT',
      protocolVersion: 4,
      clean: true,
      keepalive: 60,
    });
    const packet = packets[0];
    if (packet?.cmd !== 'connect') throw new Error('Expected CONNECT');
    expect(packet.clientId).toMatch(/^mqttjs_/);
    expect(packet.will).toBeUndefined();
    expect(packet.username).toBeUndefined();
    expect(packet.password).toBeUndefined();
    await client.disconnect();
  } finally {
    stream.destroy();
  }
});

test('rejects a missing topic from a JavaScript caller without writing PUBLISH', async () => {
  const { options, packets, stream } = peer(5, { cmd: 'connack', sessionPresent: false, reasonCode: 0 });

  try {
    const client = await connect(options);

    const emitted = new Promise<unknown>((resolve) => {
      client.once('error', resolve);
    });
    const publish = client.publish.bind(client);
    const publication: unknown = Reflect.apply(publish, undefined, [{ payload: 'missing topic' }]);
    await expect(publication).rejects.toThrow(/topic|Transport closed/i);
    await expect(emitted).resolves.toHaveProperty('message', 'Invalid topic');

    expect(packets).toHaveLength(1);
    expect(packets[0]?.cmd).toBe('connect');
  } finally {
    stream.destroy();
  }
});
