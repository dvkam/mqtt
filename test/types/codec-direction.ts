import type { BrokerPacket, ClientPacket, WirePacket } from '../../dist/codec.js';

type RequireTrue<Value extends true> = Value;
type Same<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;

export type ClientPacketsEncode = RequireTrue<
  ClientPacket extends Parameters<typeof import('../../dist/codec.js').encodePacket>[0] ? true : false
>;
export type ClientCommandsArePinned = RequireTrue<
  Same<
    ClientPacket['cmd'],
    'connect' | 'subscribe' | 'unsubscribe' | 'publish' | 'puback' | 'pubrec' | 'pubrel' | 'pubcomp' | 'pingreq' | 'disconnect'
  >
>;
export type BrokerCommandsArePinned = RequireTrue<
  Same<
    BrokerPacket['cmd'],
    'connack' | 'publish' | 'puback' | 'pubrec' | 'pubrel' | 'pubcomp' | 'suback' | 'unsuback' | 'pingresp' | 'disconnect'
  >
>;
export type DirectionsCoverTheCodec = RequireTrue<Same<ClientPacket['cmd'] | BrokerPacket['cmd'], WirePacket['cmd']>>;
