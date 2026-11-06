declare module '*.wire' with { type: 'bytes' } {
  const packetBytes: Uint8Array;
  export default packetBytes;
}
