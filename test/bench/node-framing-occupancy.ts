import assert from 'node:assert/strict';
import { NodePacketDecoder } from '../../src/nodePacketDecoder.ts';
import { StreamingNodeDecoder } from '../experiments/streaming-node-decoder.ts';
import { observeFramingOccupancy } from '../experiments/node-framing-occupancy.ts';

const wire = Uint8Array.from([0x30, 0x84, 2, 0, 1, 97, 0, ...new Uint8Array(256).fill(120)]);
for (const strategy of ['compact', 'streaming'] as const) {
  for (const fragmentBytes of [wire.length, 1]) {
    for (const completion of ['complete', 'partial-stop'] as const) {
      let packets = 0;
      let checksum = 0;
      const options = {
        maxPacketBytes: wire.length,
        onPacket(packet: unknown) {
          if (typeof packet !== 'object' || packet === null || !('payload' in packet) || !Buffer.isBuffer(packet.payload))
            throw new Error('Expected publication');
          packets++;
          checksum += packet.payload.byteLength;
        },
      };
      const decoder = strategy === 'compact' ? new NodePacketDecoder(options) : new StreamingNodeDecoder(options);
      const observation = observeFramingOccupancy(decoder, strategy);
      try {
        const input = completion === 'complete' ? wire : wire.subarray(0, wire.length - 1);
        for (let offset = 0; offset < input.length; offset += fragmentBytes)
          decoder.push(input.subarray(offset, offset + fragmentBytes));
        const beforeRetirement = observation.snapshot();
        if (completion === 'complete') decoder.finish();
        else decoder.stop(new Error('Measurement retirement'));
        const afterRetirement = observation.snapshot();
        assert.equal(packets, completion === 'complete' ? 1 : 0);
        assert.equal(checksum, completion === 'complete' ? 256 : 0);
        assert.equal(afterRetirement.currentNativeBytes + afterRetirement.currentAssemblyCapacity, 0);
        console.log(
          JSON.stringify({
            strategy,
            fragmentBytes,
            completion,
            wireBytes: wire.length,
            inputBytes: input.length,
            runtime: process.version,
            packets,
            checksum,
            beforeRetirement,
            afterRetirement,
          }),
        );
      } finally {
        observation.restore();
      }
    }
  }
}
