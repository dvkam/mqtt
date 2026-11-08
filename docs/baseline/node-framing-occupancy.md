# Node framing occupancy observations

Captured on 8 November 2026 with Node v26.13.0 under the same WSL2 host as the framing measurements. Runner and observer source is ece031c0ef4451db20da5af0461c92cdf3ef19e5. The production decoder and experimental streaming comparator are unchanged from the Node integration. Dependencies remain mqtt-packet 9.0.2 and its pinned bl 6.1.6.

## Method and limits

Run from the repository root with the pinned development runtime:

```sh
node test/bench/node-framing-occupancy.ts > ../node-framing-occupancy-results.jsonl
```

The fixed MQTT 5 QoS 0 PUBLISH is 263 wire bytes. It contains topic a, an empty property section and 256 payload bytes. Its Remaining Length is 260 encoded as two bytes. Both candidates use the same 263-byte cap and accepted packet profile. Input is contiguous or supplied in one-byte views. A partial case omits the final byte and then stops the decoder. No timing, allocation-volume, RSS or GC measurement runs in this observer.

The test-only observer wraps the pinned native BufferList instance's append method. It reads logical bytes and fragment count after append returns, before the parser consumes them. For compact assembly it also observes capacity before and after the decoder's private flush method. That captures a completed allocation even when the decoder clears its field before returning from push. Runtime guards reject unsupported classes, fields and method shapes. Hooks preserve the original receiver, arguments, return value and thrown error, and callers restore them in finally. Nested observation of one instance is rejected.

These private fields are a version-specific research seam. They are not a published API. The observer adds work and holds references; its execution cannot support throughput or object-lifetime claims. After retirement, current counters follow ownership through the wrapper's active decoder reference. Zero means that the wrapper released ownership, not that the captured native list became empty or the garbage collector freed it. The returned observation object can retain the list and captured buffers even after hook restoration, while that object remains reachable. Restoring methods does not prove memory release.

Native-list bytes and assembly capacity must not be added. During compact decoding they can describe the same backing storage, and their peaks need not occur together. Fragment count is a count of native Buffer views, not the allocation size of their objects or list metadata. Header scratch storage, decoded objects, retained payloads and process memory are outside these counters.

## Individual peak observations

The fragment column is the maximum input view size. Partial contiguous input is 262 actual bytes, despite the 263-byte fragment setting.

| Candidate | Fragment bytes | Completion | Input bytes | Peak native bytes | Peak native fragments | Peak assembly capacity |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| Compact | 263 | Complete | 263 | 262 | 1 | 262 |
| Compact | 263 | Partial then stop | 262 | 1 | 1 | 262 |
| Compact | 1 | Complete | 263 | 262 | 1 | 262 |
| Compact | 1 | Partial then stop | 262 | 1 | 1 | 262 |
| Streaming | 263 | Complete | 263 | 260 | 1 | 0 |
| Streaming | 263 | Partial then stop | 262 | 259 | 1 | 0 |
| Streaming | 1 | Complete | 263 | 260 | 260 | 0 |
| Streaming | 1 | Partial then stop | 262 | 259 | 259 | 0 |

## Current ownership before retirement

| Candidate | Fragment bytes | Completion | Native bytes | Native fragments | Assembly capacity |
| --- | ---: | --- | ---: | ---: | ---: |
| Compact | 263 | Complete | 0 | 0 | 0 |
| Compact | 263 | Partial then stop | 0 | 0 | 262 |
| Compact | 1 | Complete | 0 | 0 | 0 |
| Compact | 1 | Partial then stop | 0 | 0 | 262 |
| Streaming | 263 | Complete | 0 | 0 | 0 |
| Streaming | 263 | Partial then stop | 259 | 1 | 0 |
| Streaming | 1 | Complete | 0 | 0 | 0 |
| Streaming | 1 | Partial then stop | 259 | 259 | 0 |

Every complete case delivered one packet with payload-length checksum 256. Every partial case delivered zero packets with checksum zero. After finish or stop, all eight cases reported zero current native bytes, native fragments and assembly capacity. Peak counters remained exactly as in the first table. These statements preserve the repeated output fields without duplicating the table.

Compact assembly keeps one admitted remainder even before the body arrives. Streaming avoids that owned assembly but can retain one native fragment per body byte in this workload. The complete one-byte case observed 260 native fragments. This explains a metadata-pressure mechanism; it does not quantify heap overhead or establish a general memory or performance advantage.

The initial zero-result observer failed all seven calibration tests. The expanded suite checks contiguous and fragmented peaks, partial ownership, zero-body immediate flush, unsupported shapes, per-instance isolation, restoration after caller failure, failed installation, nested observers and direct Node execution. A separate native-entry regression first reproduced unresolved .js imports before the tool switched to physical .ts imports. Removing the pre-flush observation initially survived the nonempty PUBLISH calibration because a later hook could still see the allocation. The zero-body PINGRESP case now detects that missing observation. Raw output remains local as node-framing-occupancy-results.jsonl. Temporary external-allocation accounting remains open in #75.
