import packetBytes from './publish.wire' with { type: 'bytes' };
// @ts-expect-error A wire fixture requires the bytes import attribute.
import missingAttribute from './publish.wire';

// oxlint-disable-next-line typescript/no-unsafe-assignment -- The compiler fixture tests a custom bytes import attribute declared by the adjacent ambient module.
export const fixtureBytes: Uint8Array = packetBytes;
void missingAttribute;
