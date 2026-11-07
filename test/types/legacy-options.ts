import type { IAuthPacket, IPublishPacket, Packet } from 'mqtt-packet';
import type { Readable } from 'node:stream';
import type { ConnectOptions } from '../../dist/interface/connectOptions.js';
import type { WebSocketStream } from '../../dist/connectionFactory/interfaces/webSocketStream.js';
import { Store } from '../../dist/store.js';

type IsAny<ValueType> = 0 extends 1 & ValueType ? true : false;
type RequireFalse<ValueType extends false> = ValueType;
type RequireTrue<ValueType extends true> = ValueType;
type LegacyOptions = Required<ConnectOptions>;
type MigratedOption =
  | 'objectMode'
  | 'autoUseTopicAlias'
  | 'autoAssignTopicAlias'
  | 'reschedulePings'
  | 'reconnectPeriod'
  | 'incomingStore'
  | 'outgoingStore'
  | 'queueQoSZero'
  | 'customHandleAcks'
  | 'authPacket';

export type OptionsHaveSpecificTypes = RequireFalse<IsAny<LegacyOptions[MigratedOption]>>;
export type AliasRejectsText = RequireFalse<'yes' extends LegacyOptions['autoUseTopicAlias'] ? true : false>;
export type IntervalRejectsText = RequireFalse<'later' extends LegacyOptions['reconnectPeriod'] ? true : false>;
export type StoreRejectsNumbers = RequireFalse<42 extends LegacyOptions['incomingStore'] ? true : false>;
export type AckHandlerRejectsNumbers = RequireFalse<42 extends LegacyOptions['customHandleAcks'] ? true : false>;
export type AuthRejectsOtherCommands = RequireFalse<{ cmd: 'pingreq' } extends LegacyOptions['authPacket'] ? true : false>;
export type UnusedSetterIsAbsent = RequireFalse<'setReadable' extends keyof WebSocketStream ? true : false>;

interface CustomStorage {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The compiler fixture checks a custom store receiving the original mutable packet.
  put(packet: Packet): Promise<void>;
  get(packet: Readonly<{ messageId?: number }>): Promise<Packet>;
  del(packet: Readonly<{ messageId?: number }>): Promise<Packet>;
  createStream(): Promise<Readable>;
  close(): Promise<void>;
}
export type CustomStoreIsAccepted = RequireTrue<CustomStorage extends LegacyOptions['incomingStore'] ? true : false>;

export const validLegacyOptions: ConnectOptions = {
  objectMode: false,
  autoUseTopicAlias: true,
  autoAssignTopicAlias: false,
  reschedulePings: true,
  reconnectPeriod: 1000,
  incomingStore: new Store(),
  outgoingStore: new Store(),
  queueQoSZero: true,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The compiler fixture preserves mutable payload and publication arguments in the legacy handler.
  customHandleAcks(topic, payload, packet, complete) {
    topic.toUpperCase();
    payload.toString('hex');
    const publication: IPublishPacket = packet;
    publication.topic = 'custom-store/topic';
    complete(null, 0);
  },
  authPacket: { cmd: 'auth', reasonCode: 0x18, properties: { authenticationMethod: 'test' } } satisfies Partial<IAuthPacket>,
};
