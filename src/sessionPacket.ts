import type { Packet } from 'mqtt-packet';
import type { FramedPacket, UserProperty } from './wireCodec.ts';
import { brokerPacketDirectionError } from './protocolInputError.ts';

type UserPropertyMap = Record<string, string | string[]>;

function userPropertyMap(tuples: readonly UserProperty[] | undefined): UserPropertyMap | undefined {
  if (tuples === undefined || tuples.length === 0) return undefined;
  const grouped = new Map<string, string | string[]>();
  for (const [key, value] of tuples) {
    const existing = grouped.get(key);
    if (existing === undefined) grouped.set(key, value);
    else if (typeof existing === 'string') grouped.set(key, [existing, value]);
    else existing.push(value);
  }
  return Object.fromEntries(grouped);
}

function defined<Fields extends Record<string, unknown>>(fields: Fields): Fields | undefined {
  const entries = Object.entries(fields).filter((entry: Readonly<[string, unknown]>) => entry[1] !== undefined);
  if (entries.length === 0) return undefined;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Removing undefined members keeps every remaining key and value of Fields.
  return Object.fromEntries(entries) as Fields;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native byte views retain mutable backing buffers.
function nodeBytes(bytes: Uint8Array | undefined): Buffer | undefined {
  if (bytes === undefined) return undefined;
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Give a decoded packet the shape the shared session reads. `length` is the MQTT Remaining Length. */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Decoded packets carry mutable byte views that the session hands to the application.
export function toSessionPacket(packet: FramedPacket, length: number): Packet {
  switch (packet.cmd) {
    case 'connack': {
      const properties = defined({
        sessionExpiryInterval: packet.sessionExpiryInterval,
        receiveMaximum: packet.receiveMaximum,
        maximumQoS: packet.maximumQoS,
        retainAvailable: packet.retainAvailable,
        maximumPacketSize: packet.maximumPacketSize,
        assignedClientIdentifier: packet.assignedClientIdentifier,
        topicAliasMaximum: packet.topicAliasMaximum,
        reasonString: packet.reasonString,
        userProperties: userPropertyMap(packet.userProperties),
        wildcardSubscriptionAvailable: packet.wildcardSubscriptionAvailable,
        subscriptionIdentifiersAvailable: packet.subscriptionIdentifiersAvailable,
        sharedSubscriptionAvailable: packet.sharedSubscriptionAvailable,
        serverKeepAlive: packet.serverKeepAlive,
        responseInformation: packet.responseInformation,
        serverReference: packet.serverReference,
        authenticationMethod: packet.authenticationMethod,
        authenticationData: nodeBytes(packet.authenticationData),
      });
      return {
        cmd: 'connack',
        length,
        sessionPresent: packet.sessionPresent,
        reasonCode: packet.reasonCode,
        ...(properties ? { properties } : {}),
      };
    }
    case 'publish': {
      const identifiers = packet.subscriptionIdentifiers;
      const properties = defined({
        payloadFormatIndicator: packet.payloadFormatIndicator === undefined ? undefined : packet.payloadFormatIndicator === 1,
        messageExpiryInterval: packet.messageExpiryInterval,
        topicAlias: packet.topicAlias,
        contentType: packet.contentType,
        responseTopic: packet.responseTopic,
        correlationData: nodeBytes(packet.correlationData),
        subscriptionIdentifier:
          identifiers === undefined ? undefined : identifiers.length === 1 ? identifiers[0] : [...identifiers],
        userProperties: userPropertyMap(packet.userProperties),
      });
      const payload = nodeBytes(packet.payload) ?? Buffer.alloc(0);
      const fields = {
        cmd: 'publish' as const,
        length,
        topic: packet.topic,
        payload,
        retain: packet.retain ?? false,
        ...(properties ? { properties } : {}),
      };
      if (packet.qos === 1 || packet.qos === 2)
        return { ...fields, qos: packet.qos, dup: packet.dup ?? false, messageId: packet.messageId };
      return { ...fields, qos: 0, dup: false };
    }
    case 'puback':
    case 'pubrec':
    case 'pubrel':
    case 'pubcomp': {
      const properties = defined({ reasonString: packet.reasonString, userProperties: userPropertyMap(packet.userProperties) });
      return {
        cmd: packet.cmd,
        length,
        messageId: packet.messageId,
        reasonCode: packet.reasonCode,
        ...(properties ? { properties } : {}),
      };
    }
    case 'suback':
    case 'unsuback': {
      const properties = defined({ reasonString: packet.reasonString, userProperties: userPropertyMap(packet.userProperties) });
      return {
        cmd: packet.cmd,
        length,
        messageId: packet.messageId,
        ...(properties ? { properties } : {}),
        granted: [...packet.granted],
      };
    }
    case 'disconnect': {
      const properties = defined({
        reasonString: packet.reasonString,
        serverReference: packet.serverReference,
        userProperties: userPropertyMap(packet.userProperties),
      });
      return { cmd: 'disconnect', length, reasonCode: packet.reasonCode ?? 0, ...(properties ? { properties } : {}) };
    }
    case 'auth':
      return { cmd: 'auth', length, reasonCode: packet.reasonCode };
    case 'pingresp':
      return { cmd: 'pingresp', length };
    case 'pingreq':
    case 'connect':
    case 'subscribe':
    case 'unsubscribe':
    default:
      // NodePacketDecoder rejects these broker-direction packets by their fixed header.
      throw brokerPacketDirectionError(packet.cmd);
  }
}
