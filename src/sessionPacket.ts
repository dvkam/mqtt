import type { IPublishPacket, Packet } from 'mqtt-packet';
import type { UserProperty, WirePacket } from './codec.ts';

type UserPropertyMap = Record<string, string | string[]>;

export function userPropertyMap(tuples: readonly UserProperty[] | undefined): UserPropertyMap | undefined {
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

export function defined<Fields extends Record<string, unknown>>(fields: Fields): Fields | undefined {
  const entries = Object.entries(fields).filter((entry: Readonly<[string, unknown]>) => entry[1] !== undefined);
  if (entries.length === 0) return undefined;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Removing undefined members keeps every remaining key and value of Fields.
  return Object.fromEntries(entries) as Fields;
}

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native byte views retain mutable backing buffers.
export function nodeBytes(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Give a decoded packet other than PUBLISH the shape the shared session reads. `length` is the MQTT Remaining Length. */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Decoded packets carry mutable byte views that the session hands to the application.
export function toSessionPacket(packet: Exclude<WirePacket, { cmd: 'publish' }>, length: number): Exclude<Packet, IPublishPacket> {
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
        authenticationData: packet.authenticationData === undefined ? undefined : nodeBytes(packet.authenticationData),
      });
      return {
        cmd: 'connack',
        length,
        sessionPresent: packet.sessionPresent,
        reasonCode: packet.reasonCode,
        ...(properties ? { properties } : {}),
      };
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
      return { cmd: 'pingreq', length };
    case 'connect':
      return {
        cmd: 'connect',
        length,
        clientId: packet.clientId,
        protocolVersion: 5,
        protocolId: 'MQTT',
        clean: packet.cleanStart ?? true,
      };
    case 'subscribe':
      return {
        cmd: 'subscribe',
        length,
        messageId: packet.messageId,
        subscriptions: packet.topics.map((topic) => ({ topic, qos: packet.qos ?? 0 })),
      };
    case 'unsubscribe':
      return { cmd: 'unsubscribe', length, messageId: packet.messageId, unsubscriptions: [...packet.topics] };
    default:
      throw new Error('Unsupported MQTT packet');
  }
}
