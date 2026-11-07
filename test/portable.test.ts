import type { Packet } from 'mqtt-packet';
import { expect, test, vi } from 'vitest';
import { connectPortable, type PacketTransport } from '../src/portable.js';

function peer() {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  let receive: (packet: Packet) => void;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  let closed: (error: Error) => void;
  const packets: Packet[] = [];
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  const sent: PacketTransport['send'] = async (packet) => {
    packets.push(packet);
    if (packet.cmd === 'connect') receive({ cmd: 'connack', sessionPresent: false, reasonCode: 0 });
    if (packet.cmd === 'subscribe') receive({ cmd: 'suback', messageId: packet.messageId, granted: [0] });
    if (packet.cmd === 'publish') receive(packet);
  };
  const transport: PacketTransport = {
    send: sent,
    listen(onPacket, onClose) {
      receive = onPacket;
      closed = onClose;
      return () => {};
    },
    async close() {},
  };
  return {
    transport,
    packets,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    receive: (packet: Packet) => {
      receive(packet);
    },
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    close: (error: Error) => {
      closed(error);
    },
  };
}

test('completes the MQTT 5 QoS 0 tracer through an injected packet transport', async () => {
  const { transport, packets } = peer();
  const messages: Packet[] = [];
  const client = await connectPortable(transport, {
    clientId: 'tracer',
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    onMessage: (packet) => {
      messages.push(packet);
    },
  });
  await client.subscribe('tracer/echo');
  await client.publish('tracer/echo', 'hello');
  await client.disconnect();

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  expect(packets.map(({ cmd }) => cmd)).toEqual(['connect', 'subscribe', 'publish', 'disconnect']);
  expect(messages).toEqual([{ cmd: 'publish', qos: 0, topic: 'tracer/echo', payload: 'hello', dup: false, retain: false }]);
});

test('settles a blocked publish with the transport failure before drain', async () => {
  const broker = peer();
  const client = await connectPortable(broker.transport, { clientId: 'tracer' });
  broker.transport.send = async () => new Promise(() => {});
  const published = client.publish('tracer/echo', 'hello');
  broker.close(new Error('closed before drain'));
  await expect(published).rejects.toThrow('closed before drain');
  await expect(client.publish('tracer/echo', 'again')).rejects.toThrow('closed before drain');
});

test.each([0, 1, 2, 3, 4, 5, 6, 7])('fences a retry %i microtasks after the ping timer fires', async (hops) => {
  vi.useFakeTimers();
  try {
    const { transport, packets } = peer();
    const client = await connectPortable(transport, { clientId: 'tracer', timeoutMs: 100 });
    const first = client.ping().catch((error: unknown) => error);
    vi.advanceTimersByTime(100);
    const retry = new Promise<void>((resolve, reject) => {
      let remaining = hops;
      const schedule = () => {
        if (remaining-- > 0) queueMicrotask(schedule);
        else client.ping().then(resolve, reject);
      };
      schedule();
    }).catch((error: unknown) => error);
    await Promise.all([first, retry]);
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    expect(packets.map(({ cmd }) => cmd)).toEqual(['connect', 'pingreq']);
  } finally {
    vi.useRealTimers();
  }
});

test('retires a ping whose transport write rejects after admitting bytes', async () => {
  const { transport, packets } = peer();
  const client = await connectPortable(transport, { clientId: 'tracer' });
  const writeError = new Error('could not confirm the write');
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  transport.send = async (packet) => {
    packets.push(packet);
    throw writeError;
  };
  await expect(client.ping()).rejects.toBe(writeError);
  await expect(client.ping()).rejects.toBe(writeError);
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  expect(packets.map(({ cmd }) => cmd)).toEqual(['connect', 'pingreq']);
});

test('ignores a queued application frame delivered after transport failure', async () => {
  const broker = peer();
  const messages: Packet[] = [];
  const client = await connectPortable(broker.transport, {
    clientId: 'late-frame',
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    onMessage: (p) => {
      messages.push(p);
    },
  });
  const reason = new Error('transport closed');
  broker.close(reason);
  broker.receive({ cmd: 'publish', topic: 'late', payload: 'late', qos: 0, dup: false, retain: false });
  await expect(client.publish('late', 'reply')).rejects.toBe(reason);
  expect(messages).toEqual([]);
});
