import * as mqtt from 'mqtt-packet';
import type { MqttClient } from './client.js';

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Writing observes mutable client state and passes the original packet buffers to the transport.
export async function write(client: Readonly<MqttClient>, packet: Readonly<mqtt.Packet>): Promise<void> {
  const stream = client.conn;
  if ((!client.connected && !client.connecting) || stream.destroyed) throw new Error('connection closed');
  if (mqtt.writeToStream(packet, stream, { protocolVersion: client._options.protocolVersion })) return;
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- writeToStream can synchronously destroy the stream.
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
    const failed = (error: Readonly<Error>) => {
      cleanup();
      reject(error);
    };
    const closed = () => {
      failed(new Error('Transport closed before drain'));
    };
    stream.once('drain', drained);
    stream.once('close', closed);
    stream.once('error', failed);
  });
}
