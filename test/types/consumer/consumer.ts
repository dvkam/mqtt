import { publishTopic } from '../../../.type-fixtures/packet.js';

const topic: string | undefined = publishTopic({
  cmd: 'publish',
  topic: 'test',
  payload: 'hello',
  qos: 0,
  dup: false,
  retain: false,
});
void topic;
