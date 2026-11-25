import { readdirSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

// Plain Error, RangeError and TypeError constructions left in src/ per file. Lower an entry when an error gains an
// MqttError code; the test fails if a count grows or a new file adds one. docs/errors.md lists what each group is.
const uncoded: Readonly<Record<string, number>> = {
  'browserClient.ts': 1,
  'inboundPackets.ts': 1,
  'nativeWriteBudget.ts': 1,
  'outboundQosOne.ts': 1,
  'packetFramer.ts': 14,
  'packetInput.ts': 5,
  'portable.ts': 1,
  'publicationAdmission.ts': 1,
  'subscriptionExchanges.ts': 1,
  'timeout.ts': 1,
  'transportCore.ts': 1,
  'websocketLimits.ts': 1,
  'wireCodec.ts': 40,
  'wireProperties.ts': 10,
};

test('src/ adds no uncoded Error constructions', () => {
  const source = new URL('../src/', import.meta.url);
  const counts: Record<string, number> = {};
  for (const entry of readdirSync(source, { recursive: true, encoding: 'utf8' })) {
    if (!entry.endsWith('.ts')) continue;
    const count = readFileSync(new URL(entry, source), 'utf8').match(/\bnew (?:Error|RangeError|TypeError)\(/g)?.length ?? 0;
    if (count > 0) counts[entry] = count;
  }
  expect(counts).toEqual(uncoded);
});
