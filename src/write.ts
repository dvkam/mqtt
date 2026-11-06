import * as mqtt from 'mqtt-packet';
import type { MqttClient } from './client.js';

export async function write(client: MqttClient, packet: mqtt.Packet): Promise<void> {
  const stream = client.conn;
  if ((!client.connected && !client.connecting) || stream.destroyed) throw new Error('connection closed');
  if (mqtt.writeToStream(packet, stream, { protocolVersion: client._options.protocolVersion })) return;
  if (stream.destroyed || client.errored) throw new Error('Transport closed before drain');

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off('drain', drained);
      stream.off('close', closed);
      stream.off('error', failed);
    };
    const drained = () => {
      cleanup();
      resolve();
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const closed = () => failed(new Error('Transport closed before drain'));
    stream.once('drain', drained);
    stream.once('close', closed);
    stream.once('error', failed);
  });
}
