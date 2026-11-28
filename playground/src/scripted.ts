import { encodePacket, PacketDecoder } from 'mqtt/codec';
import type { ByteInbound, ByteTransport } from 'mqtt/portable';

/** Whether an MQTT topic filter matches a topic name. A filter that starts with a wildcard matches no `$` topic. */
export function matches(filter: string, topic: string): boolean {
  const filterLevels = filter.split('/');
  const topicLevels = topic.split('/');
  if (topic.startsWith('$') && (filterLevels[0] === '#' || filterLevels[0] === '+')) return false;
  for (let index = 0; index < filterLevels.length; index++) {
    const level = filterLevels[index];
    if (level === '#') return true;
    if (index >= topicLevels.length) return false;
    if (level !== '+' && level !== topicLevels[index]) return false;
  }
  return filterLevels.length === topicLevels.length;
}

/** A broker in the page, and the way to end its open connection. */
export interface ScriptedBroker {
  readonly transport: ByteTransport;
  /** Ends the open connection as a peer close would. Returns false when no connection is open. */
  drop(): boolean;
}

interface ApplicationMessage {
  readonly topic: string;
  readonly payload: Uint8Array;
  readonly qos: 0 | 1;
  readonly retain: boolean;
}

/**
 * A broker that runs in the page and serves one connection at a time. It accepts CONNECT with Maximum QoS 1, grants every
 * SUBSCRIBE, acknowledges QoS 1 PUBLISH, answers PINGREQ and sends each PUBLISH to the subscriptions it matches.
 *
 * It keeps the last retained message of each topic until the page closes, sends it to a new subscription with the retain
 * flag set, and removes it for a retained message with an empty payload. It publishes the Will at once when a connection
 * ends without a DISCONNECT of reason 0x00, and it ignores the Will Delay Interval. Each connection starts with no
 * subscriptions, as a clean session does, so only a retained Will reaches a later subscription.
 *
 * It refuses the topic `playground/refused` with PUBACK reason 0x87, so the page can show a refusal. It never acknowledges
 * `playground/unacknowledged`, so a drop leaves that publication uncertain.
 */
export function scriptedBroker(): ScriptedBroker {
  let end: (() => void) | undefined;
  const retained = new Map<string, ApplicationMessage>();
  const transport: ByteTransport = {
    name: 'Scripted broker',
    // oxlint-disable-next-line typescript/require-await -- ByteTransport.open in byteTransport.d.ts of the packed client returns a promise, and promise-function-async requires an async function for that. This broker opens without waiting for anything.
    async open(inbound: Readonly<ByteInbound>) {
      const decoder = new PacketDecoder();
      const subscriptions = new Map<string, 0 | 1>();
      let will: ApplicationMessage | undefined;
      let nextId = 1;
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- encodePacket in wireCodec.d.ts of the packed client returns a native Uint8Array, and ByteInbound.bytes takes it.
      const send = (bytes: Uint8Array): void => {
        // A socket delivers a reply after the write that caused it has returned.
        queueMicrotask(() => {
          inbound.bytes(bytes);
        });
      };
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The payload of a PUBLISH in WirePacket of wireCodec.d.ts in the packed client is a native Uint8Array, and encodePacket takes it.
      const deliver = (message: ApplicationMessage, granted: 0 | 1, retain: boolean): void => {
        const { topic, payload } = message;
        if (granted === 0 || message.qos === 0) {
          send(encodePacket({ cmd: 'publish', topic, payload, retain }));
          return;
        }
        const messageId = nextId;
        nextId = nextId === 65_535 ? 1 : nextId + 1;
        send(encodePacket({ cmd: 'publish', topic, payload, qos: 1, messageId, retain }));
      };
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The payload of a PUBLISH in WirePacket of wireCodec.d.ts in the packed client is a native Uint8Array, and deliver passes it to encodePacket.
      const accept = (message: ApplicationMessage): void => {
        if (message.retain) {
          if (message.payload.byteLength === 0) retained.delete(message.topic);
          else retained.set(message.topic, { ...message, payload: message.payload.slice() });
        }
        for (const [filter, granted] of subscriptions) if (matches(filter, message.topic)) deliver(message, granted, false);
      };
      const release = (): void => {
        subscriptions.clear();
        if (will !== undefined) accept(will);
        will = undefined;
      };
      const current = (): void => {
        inbound.end();
        release();
      };
      end = current;
      return {
        bufferedBytes: 0,
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- ByteWriter.write in byteTransport.d.ts of the packed client takes the encoded Uint8Array and returns a promise, and promise-function-async requires an async function for that. This broker handles the bytes at once.
        async write(bytes: Uint8Array) {
          for (const packet of decoder.push(bytes)) {
            switch (packet.cmd) {
              case 'connect':
                if (packet.will?.qos === 2) {
                  send(encodePacket({ cmd: 'connack', sessionPresent: false, reasonCode: 0x9b }));
                  break;
                }
                if (packet.will !== undefined) {
                  const { topic, payload, qos = 0, retain = false } = packet.will;
                  will = { topic, payload: payload.slice(), qos, retain };
                }
                send(encodePacket({ cmd: 'connack', sessionPresent: false, reasonCode: 0, receiveMaximum: 16, maximumQoS: 1 }));
                break;
              case 'subscribe': {
                const granted = packet.qos ?? 0;
                for (const filter of packet.topics) subscriptions.set(filter, granted);
                send(encodePacket({ cmd: 'suback', messageId: packet.messageId, granted: packet.topics.map(() => granted) }));
                for (const filter of packet.topics)
                  for (const message of retained.values()) if (matches(filter, message.topic)) deliver(message, granted, true);
                break;
              }
              case 'unsubscribe':
                for (const filter of packet.topics) subscriptions.delete(filter);
                send(encodePacket({ cmd: 'unsuback', messageId: packet.messageId, granted: packet.topics.map(() => 0) }));
                break;
              case 'pingreq':
                send(encodePacket({ cmd: 'pingresp' }));
                break;
              case 'publish': {
                const { topic, payload, qos = 0, retain = false } = packet;
                const refused = topic === 'playground/refused';
                if (packet.qos === 1 && topic === 'playground/unacknowledged') break;
                if (packet.qos === 1)
                  send(encodePacket({ cmd: 'puback', messageId: packet.messageId, reasonCode: refused ? 0x87 : 0 }));
                if (!refused) accept({ topic, payload, qos, retain });
                break;
              }
              case 'disconnect':
                if (packet.reasonCode === undefined || packet.reasonCode === 0) will = undefined;
                break;
              case 'connack':
              case 'puback':
              case 'suback':
              case 'unsuback':
              case 'pingresp':
                break;
            }
          }
        },
        // oxlint-disable-next-line typescript/require-await -- ByteWriter.close in byteTransport.d.ts of the packed client returns a promise, and promise-function-async requires an async function for that. This broker closes without waiting for anything.
        async close() {
          if (end === current) end = undefined;
          release();
        },
      };
    },
  };
  return {
    transport,
    drop() {
      if (end === undefined) return false;
      const current = end;
      end = undefined;
      current();
      return true;
    },
  };
}
