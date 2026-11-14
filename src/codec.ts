/** The portable MQTT 5 codec. The Node-only framed decode in `wireCodec.ts` stays internal. */
export { encodePacket, PacketDecoder, type UserProperty, type WirePacket } from './wireCodec.js';
