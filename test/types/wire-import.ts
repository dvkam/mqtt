import packetBytes from './publish.wire' with { type: 'bytes' };
// @ts-expect-error A wire fixture requires the bytes import attribute.
import missingAttribute from './publish.wire';

export const fixtureBytes: Uint8Array = packetBytes;
void missingAttribute;
