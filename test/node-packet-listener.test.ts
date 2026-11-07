import { expect, test } from 'vitest';
import type { IPublishPacket, Packet } from 'mqtt-packet';
import { nodePacketListener } from '../src/nodePacketListener.js';

test('forwards the original QoS 0 Buffer packet and acknowledgment objects', () => {
  const publication: IPublishPacket = {
    cmd: 'publish',
    qos: 0,
    dup: false,
    retain: false,
    topic: 'typed/message',
    payload: Buffer.from([0, 255]),
  };
  const acknowledgment: Packet = { cmd: 'pingresp' };
  const received: unknown[] = [];
  const listen = nodePacketListener((packet: unknown) => {
    received.push(packet);
  });
  listen(publication);
  listen(acknowledgment);
  expect(received).toHaveLength(2);
  expect(received[0]).toBe(publication);
  expect(received[1]).toBe(acknowledgment);
});

test('does not expose unsupported publication shapes through the precise callback', () => {
  const received: unknown[] = [];
  const listen = nodePacketListener((packet: unknown) => {
    received.push(packet);
  });
  const publication: IPublishPacket = {
    cmd: 'publish',
    qos: 0,
    dup: false,
    retain: false,
    topic: 'typed/message',
    payload: 'encoder input',
  };
  listen(publication);
  listen({ ...publication, qos: 1, messageId: 1, payload: Buffer.from('unsupported') });
  expect(received).toEqual([]);
});
