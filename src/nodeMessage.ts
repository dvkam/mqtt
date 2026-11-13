import type { MessageProperties } from './messageProperties.js';
import type { QosOneMessage } from './session.js';

export interface NodeMessage extends MessageProperties {
  cmd: 'publish';
  topic: string;
  payload: Buffer;
  qos: 0;
  dup: false;
  retain: boolean;
  correlationData?: Buffer;
}

export type NodeQosOneMessage = QosOneMessage<NodeMessage>;
