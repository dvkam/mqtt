import { Duplex } from 'node:stream';
import { once } from 'node:events';
import { generate, parser, type Packet } from 'mqtt-packet';
import { expect, test } from 'vitest';
import { connect } from '../src/index.js';

function peer(version: 4 | 5, reply?: Packet) {
  const packets: Packet[] = [];
  const decoder = parser({ protocolVersion: version });
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      decoder.parse(chunk);
      callback();
    },
    final(callback) {
      this.push(null);
      callback();
    },
  });
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
  return { options, packets, stream };
}

test.each([4, 5] as const)('writes one CONNECT, a QoS 0 publish, and DISCONNECT at protocol level %i', async (version) => {
  const { options, packets, stream } = peer(version, {
    cmd: 'connack',
    sessionPresent: false,
    ...(version === 5 ? { reasonCode: 0 } : { returnCode: 0 }),
  });
  try {
    const client = await connect(options);
    await client.publish({ topic: 'baseline/topic', payload: 'hello' });
    const finished = once(stream, 'finish');
    await client.disconnect();
    await finished;

    expect(packets.map(({ cmd }) => cmd)).toEqual(['connect', 'publish', 'disconnect']);
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
