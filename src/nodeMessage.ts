import type { IPublishPacket } from 'mqtt-packet';
import type { QosOneMessage } from './session.js';

export type NodeMessage = Omit<IPublishPacket, 'payload' | 'qos'> & {
  payload: Buffer;
  qos: 0;
};

export type NodeQosOneMessage = QosOneMessage<NodeMessage>;
