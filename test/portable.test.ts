import type { Packet } from 'mqtt-packet';
import { expect, test } from 'vitest';
import { connectPortable, type PacketTransport } from '../src/portable.js';

function peer() {
  let receive: (packet: Packet) => void;
  let closed: (error: Error) => void;
  const packets: Packet[] = [];
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
  return { transport, packets, close: (error: Error) => closed(error) };
}

test('completes the MQTT 5 QoS 0 tracer through an injected packet transport', async () => {
  const { transport, packets } = peer();
  const messages: Packet[] = [];
  const client = await connectPortable(transport, { clientId: 'tracer', onMessage: (packet) => messages.push(packet) });
  await client.subscribe('tracer/echo');
  await client.publish('tracer/echo', 'hello');
  await client.disconnect();

  expect(packets.map(({ cmd }) => cmd)).toEqual(['connect', 'subscribe', 'publish', 'disconnect']);
  expect(messages).toEqual([{ cmd: 'publish', qos: 0, topic: 'tracer/echo', payload: 'hello', dup: false, retain: false }]);
});

test('settles a blocked publish with the transport failure before drain', async () => {
  const broker = peer();
  const client = await connectPortable(broker.transport, { clientId: 'tracer' });
  broker.transport.send = () => new Promise(() => {});
  const published = client.publish('tracer/echo', 'hello');
  broker.close(new Error('closed before drain'));
  await expect(published).rejects.toThrow('closed before drain');
  await expect(client.publish('tracer/echo', 'again')).rejects.toThrow('closed before drain');
});
