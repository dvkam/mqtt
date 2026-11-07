import type { IPublishPacket } from 'mqtt-packet';

export type NodeMessage = Omit<IPublishPacket, 'payload' | 'qos'> & {
  payload: Buffer;
  qos: 0;
};
