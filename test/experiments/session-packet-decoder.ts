import type { IPublishPacket, Packet } from 'mqtt-packet';
import type { FramedPacket } from '../../src/wireCodec.js';
import { NodePacketDecoder as WirePacketDecoder } from '../../src/nodePacketDecoder.js';
import { defined, nodeBytes, toSessionPacket, userPropertyMap } from '../../src/sessionPacket.js';

type FramedPublish = Extract<FramedPacket, { cmd: 'publish' }>;

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Decoded packets carry mutable byte views.
function publishPacket(packet: FramedPublish, length: number): IPublishPacket {
  const identifiers = packet.subscriptionIdentifiers;
  const properties = defined({
    payloadFormatIndicator: packet.payloadFormatIndicator === undefined ? undefined : packet.payloadFormatIndicator === 1,
    messageExpiryInterval: packet.messageExpiryInterval,
    topicAlias: packet.topicAlias,
    contentType: packet.contentType,
    responseTopic: packet.responseTopic,
    correlationData: packet.correlationData === undefined ? undefined : nodeBytes(packet.correlationData),
    subscriptionIdentifier: identifiers === undefined ? undefined : identifiers.length === 1 ? identifiers[0] : [...identifiers],
    userProperties: userPropertyMap(packet.userProperties),
  });
  const fields = {
    cmd: 'publish' as const,
    length,
    topic: packet.topic,
    payload: nodeBytes(packet.payload),
    retain: packet.retain ?? false,
    ...(properties ? { properties } : {}),
  };
  if (packet.qos === 1 || packet.qos === 2)
    return { ...fields, qos: packet.qos, dup: packet.dup ?? false, messageId: packet.messageId };
  return { ...fields, qos: 0, dup: false };
}

type Options = Readonly<{
  maxPacketBytes?: number;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The decoder delivers mutable packets and Buffer payloads.
  onPacket: (packet: Packet) => void;
}>;

/**
 * The supported Node decoder, with every packet given mqtt-packet's shape.
 * Tests use it to compare the decoder with mqtt-packet and to read nested properties.
 */
export class NodePacketDecoder extends WirePacketDecoder {
  constructor(options: Options) {
    super({
      maxPacketBytes: options.maxPacketBytes,
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Decoded packets carry mutable byte views.
      onPacket: (packet, length) => {
        options.onPacket(packet.cmd === 'publish' ? publishPacket(packet, length) : toSessionPacket(packet, length));
      },
    });
  }
}
