# Session journal

Status: not available yet. A session state that survives a process restart is [#14](https://github.com/dvkam/mqtt/issues/14). So far the repository holds the byte format of the journal and its recovery rules, in `src/journalFormat.ts`. No entry point exports that module, nothing reads or writes a file yet, and no client option refers to it. Until the rest lands, the session state lives in memory. [Resuming the session](reconnect.md#resuming-the-session)

## Segment format, version 1

A journal is a sequence of segment files. A segment has a generation, which is the number in its file name, and holds the session state of one client at one broker: the QoS 1 and QoS 2 publications that were written and not acknowledged, the QoS 2 publications that wait for PUBCOMP, and the Packet Identifiers of inbound QoS 2 publications that wait for PUBREL. [MQTT 5 section 4.1](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html) lists these as the session state of a client.

All integers are big-endian. A text is a two-byte length and that many bytes of an MQTT UTF-8 string.

A segment starts with eight bytes, the ASCII text `MQTTJNL` and the version byte `1`. Frames follow. A frame is one commit batch. The writer syncs a frame to the disk before it writes the next one.

| Offset | Bytes | Field |
| ---: | ---: | --- |
| 0 | 4 | The ASCII text `MQJF` |
| 4 | 4 | Length of the records in bytes |
| 8 | 4 | CRC-32 of every byte of the frame after this field, as `crc32` of `node:zlib` computes it |
| 12 | 8 | Generation of the segment |
| 20 | 4 | Batch number, which counts from 1 within the segment |
| 24 | 4 | Session epoch before the first record of the frame |
| 28 | 8 | Wall clock time of the write, in milliseconds since 1970 |
| 36 | | Records |

A record is one type byte, a four-byte length and a body of that length. The first frame of a segment is a snapshot. Its first record is the `segment` record, and the records after it list everything the state holds. Each later record is one change.

| Type | Record | Body | Meaning |
| ---: | --- | --- | --- |
| 1 | `segment` | Process ID (4), uptime in seconds (4), epoch (4), established (1), next sequence number (8), then the texts host name, token, Client Identifier and broker name | The process that owns the segment, the identity of the session, its epoch and whether a CONNACK established it |
| 2 | `publication` | Sequence number (8), then a PUBLISH packet | A QoS 1 or QoS 2 publication before its first write |
| 3 | `acknowledged` | Packet Identifier (2) | A PUBACK, or a PUBREC of 0x80 or above, ended the publication |
| 4 | `received` | Packet Identifier (2) | A PUBREC below 0x80 arrived. The publication keeps its topic and waits for PUBCOMP. |
| 5 | `completed` | Packet Identifier (2) | A PUBCOMP ended the publication |
| 6 | `withdrawn` | Packet Identifier (2) | The publication was never written |
| 7 | `delivered` | Packet Identifier (2) | The handler of an inbound QoS 2 publication fulfilled |
| 8 | `released` | Packet Identifier (2) | The PUBREL of an inbound QoS 2 publication arrived |
| 9 | `releasing` | Packet Identifier (2), topic text | Snapshot only. A publication that waits for PUBCOMP. |
| 10 | `epoch` | Epoch (4), established (1) | The next session epoch starts, and everything stored is dropped |
| 11 | `connected` | Session Expiry Interval (4) | A CONNACK established the session and opened a connection |
| 12 | `ended` | Time (8) | The connection was last known to be open at this time |
| 13 | `fact` | Highest requested QoS (1), highest granted QoS (1), subscriptions acknowledged (1) | Replaces the three values |
| 14 | `closed` | None | The writer closed the journal. No record follows. |

The epoch counts the broker sessions the client knew. An `epoch` record carries the epoch before it plus one. A sequence number names a publication for the life of the journal and gives the resend order (MQTT-4.6.0-1). A new publication takes the next number.

### The stored PUBLISH

A `publication` record holds the publication as the MQTT 5 PUBLISH packet that the client's encoder writes for its first transmission, with its Packet Identifier, QoS 1 or 2, DUP 0 and the full topic name. Recovery decodes it with the client's decoder and then encodes the result again. Bytes that differ make the segment unreadable, so a stored packet never holds a Topic Alias, a Subscription Identifier or a DUP flag.

The stored packet is a storage encoding. No connection writes its bytes. Recovery turns it into the publication value that the in-memory session state holds, with its topic, payload, properties and byte counts. The session resume code checks that value against the limits of the new connection, so one rule covers a publication from memory and one from a journal. A resumed session encodes the PUBLISH again with DUP set. When the broker's new Maximum Packet Size is smaller than the publication, when it no longer accepts the QoS or a retained message, the connection ends with `ERR_MQTT_SESSION_CONFLICT` and the publication stays stored. [Resuming the session](reconnect.md#resuming-the-session) has the table. A Topic Alias belongs to one connection, and the client sends none, so a journal holds no alias and a later connection needs none.

### Recovery

Recovery reads the frames in order and stops at the first one that is short, fails its CRC-32, names another generation or does not have the next batch number.

| What recovery finds | Result |
| --- | --- |
| Every byte belongs to a valid frame | The state after the last frame |
| Bytes after the last valid frame, and no valid frame among them | A torn tail. No commit covered those bytes, so recovery drops them and returns the state after the last valid frame. |
| No valid frame at all | The segment is incomplete. Its writer stopped before the snapshot was written, and the segment holds no state. |
| A frame that is not valid, and a valid frame of the same generation with that batch number or a higher one after it | Unreadable, reason `damaged`. A writer writes a frame only after it synced the one before, so the later frame proves that a commit covered the damaged bytes. |
| A version byte other than 1 | Unreadable, reason `version` |
| A record type this version does not know, a record whose body does not match its type, or a record that does not apply to the state before it | Unreadable, reason `record` |
| A frame whose epoch is not the epoch the frames before it lead to, or an `epoch` record that does not carry the next epoch | Unreadable, reason `epoch` |

A record applies only to the state it changes. `acknowledged` and `withdrawn` name a stored publication, `received` a stored QoS 2 publication, `completed` a publication that waits for PUBCOMP and `released` a stored inbound identifier. A `publication` carries the next sequence number and an identifier that is not stored. `ended` follows an open connection and `connected` follows none. A writer appends one record for each change that took effect, so a record that fits none of these is a defect and not a tail to drop.

A frame of another generation is never taken for a frame of the segment. After a power loss a file system may leave blocks of a deleted segment in the tail of the current one, and those frames would otherwise look like proof of a commit.

Damage inside the last frame of a segment, with nothing after it, looks like a torn tail and is not one. Recovery drops that frame. Telling the two apart would take a second sync for every commit.

### Size

A frame takes 36 bytes and each record 5 bytes more than its body, so a QoS 1 publication with a 9-byte topic and a 16-byte payload takes 5 + 8 + 32 = 45 bytes, and its PUBACK takes 7. A writer starts the next segment with a new snapshot once the current one is larger than 1 MiB and larger than four times its snapshot. It checks before each frame, so a segment is at most that threshold and one frame.

### Verification

`test/journal-format.test.ts` pins the bytes of a frame and checks every row of the recovery table. Its property tests generate segments from fixed seeds and compare each recovery with a model of the record meanings that shares no code with the module. The default run takes about one second. It recovers every truncation of ten segments, flips one bit of every byte, appends zeros, noise and frames of another segment, and applies random damage. No recovery may return a state that no commit made durable. A longer run flips every bit of every byte of as many segments as it is given:

    MQTT_TEST_JOURNAL_SEGMENTS=300 pnpm -s test test/journal-format.test.ts
