import { publishTopic } from '../../../.type-fixtures/packet.js';

export const topic: string | undefined = publishTopic({
  cmd: 'publish',
  topic: 'test',
  payload: 'hello',
  qos: 0,
  dup: false,
  retain: false,
});
