import { ProtocolInputError } from './protocolInputError.js';

export function validateInboundTopic(topic: string, aliasPresent: boolean): void {
  if (aliasPresent) throw new ProtocolInputError('Unnegotiated MQTT Topic Alias', 0x94);
  if (topic.length === 0 || topic.includes('+') || topic.includes('#')) {
    throw new ProtocolInputError('Invalid MQTT PUBLISH Topic Name', 0x82);
  }
}
