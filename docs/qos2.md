# QoS 2 publishing and delivery

QoS 2 delivers each message once through four packets. The sender writes PUBLISH, the receiver answers PUBREC, the sender writes PUBREL and the receiver answers PUBCOMP. The TCP, Node WebSocket, browser and custom transport clients support it in both directions. [MQTT 5 section 4.3.3](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)

## Publish at QoS 2

```ts
await session.publish('orders/created', payload, { qos: 2 });
```

The promise settles as the table shows.

| Broker answer | Publish promise | What the client does |
| --- | --- | --- |
| PUBREC with a reason below 0x80 | Stays pending | Writes PUBREL at once, so the PUBRELs go out in the order the PUBRECs arrive (MQTT-4.6.0-4), also while an earlier PUBLISH write is still pending |
| PUBREC with a reason of 0x80 or above | Rejects with `ERR_MQTT_REFUSED`, `fatal: false` and the `reasonCode` | Writes no PUBREL, and frees the quota slot and the Packet Identifier |
| PUBCOMP with reason 0 or 0x92 | Resolves | Frees the quota slot and the Packet Identifier |

A PUBREC below 0x80 means the broker took ownership of the message. A broker may still wait for the PUBREL before it sends the message to subscribers, and Mosquitto does. The promise therefore resolves at PUBCOMP, when the broker has released the message and the exchange is over.

A PUBCOMP with reason 0x92, Packet Identifier not found, also ends the exchange and resolves the promise. The broker sends it when it no longer knows the identifier. That happens when it released the message earlier and its first PUBCOMP was lost with an earlier connection. The PUBREC had already accepted the message, so the client does not treat 0x92 as a failure.

### When the session ends first

Every pending publish promise rejects with the session's error. `onSessionEnd` and the next `connected` event of a [reconnecting client](reconnect.md#lost-publications) list each written publication in `uncertain`, with its `qos` and an `acknowledged` flag.

| `uncertain` entry | What is known | What a resumed session sends |
| --- | --- | --- |
| `qos: 2, acknowledged: false` | No PUBREC arrived, or it refused the publication. The broker may or may not have the message. | The PUBLISH again, with DUP set and the same Packet Identifier. The broker recognizes the identifier, so no second copy results. |
| `qos: 2, acknowledged: true` | A PUBREC below 0x80 arrived, so the broker has the message. The exchange did not finish, so the broker may not have released the message to subscribers. | Only the PUBREL, never the PUBLISH (MQTT-4.3.3-6). |

Without a resumed session the client sends neither packet again. An entry with `acknowledged: true` then tells you that publishing the message a second time may duplicate it.

## Quota, order and deadlines

- The session reads Maximum QoS from CONNACK. A publish with a higher QoS rejects with `ERR_MQTT_INVALID_ARGUMENT` before anything is written. `session.connection.maximumQos` holds the value.
- QoS 1 and QoS 2 publications share the broker's Receive Maximum and one queue, so they go out in call order. A QoS 2 exchange keeps its quota slot and its Packet Identifier until PUBCOMP, or until a refusing PUBREC. [MQTT 5 section 4.9](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html)
- Queued and active QoS 2 publications count toward `maxPendingPublishes` and `maxPendingPublishBytes`, as QoS 1 publications do. [Outbound QoS 1](qos1-publish.md#admission-and-quota)
- Each step has its own operation deadline of `timeoutMs`. The first covers the PUBLISH write and the PUBREC. The second starts when the PUBREC arrives and covers the PUBREL write and the PUBCOMP. A missed deadline ends the session with `ERR_MQTT_TIMEOUT`. The exchange keeps its slot until both writes have settled.
- A `signal` withdraws a publication that is still queued. After dispatch an abort rejects the caller's promise with the abort reason, and the exchange still runs to PUBCOMP and keeps its slot until then.
- A built-in transport that refuses the PUBLISH at its write budget rejects that publish and leaves the session usable, as at QoS 1.

### Unexpected acknowledgments

| Packet from the broker | What the client does |
| --- | --- |
| A second PUBREC for an exchange, or a PUBREC for the identifier of a QoS 1 exchange | Ignores it. The exchange keeps the reason code of its first PUBREC. |
| A PUBREC below 0x80 for an identifier without an exchange | Writes PUBREL with reason 0x92, so the broker can drop what it holds. After `disconnect()` it writes nothing. |
| A PUBREC of 0x80 or above for an identifier without an exchange | Ignores it |
| A PUBCOMP for an exchange that has no PUBREC yet, or for an identifier without an exchange | Ignores it. The exchange stays pending. |
| A PUBACK for a QoS 2 exchange | Ignores it |
| Packet Identifier 0, an unknown reason code or invalid fixed-header flags | Ends the session. [Error codes](errors.md) |

## Disconnect

`disconnect()` waits for the active QoS 2 exchanges as it waits for QoS 1. A PUBREC that arrives during the drain still gets its PUBREL, and the publish resolves on PUBCOMP before DISCONNECT goes out. When `drainTimeoutMs` passes first, every publication without PUBCOMP rejects with `ERR_MQTT_TIMEOUT` and the message `MQTT publish drain expired. Delivery outcome is unknown`. That includes a publication whose PUBREC already arrived. The client writes nothing after DISCONNECT (MQTT-3.14.4-1), so a PUBREC that arrives then gets no PUBREL. A session state keeps the unfinished exchanges for a resume.

## Receive at QoS 2

```ts
const client = await createTcpClient({
  host: 'localhost',
  clientId: 'reader',
  onQosOneMessage: handle,
  async onQosTwoMessage(message) {
    await saveOrder(message.topic, message.payload);
  },
}).connect();

const { grantedQos } = await client.subscribe('orders/#', { qos: 2 });
```

A QoS 2 subscription needs `onQosTwoMessage` and `onQosOneMessage`. The broker delivers each publication at the lower of its own QoS and the granted QoS, so a QoS 1 publication arrives at QoS 1 and needs its PUBACK. Without both handlers `subscribe` rejects with `ERR_MQTT_INVALID_ARGUMENT` before it writes. A QoS 0 publication goes to `onMessage` when you set it. `grantedQos` is 0, 1 or 2, because the broker may grant less than you asked for.

`onQosTwoMessage` receives the [flat message fields](public-types.md#received-message-fields) with `qos: 2`, a numeric `messageId` and a boolean `dup`. `NodeQosTwoMessage`, `BrowserQosTwoMessage` and `QosTwoMessage` name the type.

For each QoS 2 PUBLISH the client takes these steps.

1. It records the Packet Identifier and calls the handler.
2. When the handler returns or its promise fulfills, it sends PUBREC.
3. Until PUBREL arrives, every further PUBLISH with that identifier gets PUBREC again and no second handler call, with or without the DUP flag (MQTT-4.3.3-10).
4. PUBREL gets PUBCOMP and frees the identifier. A later PUBLISH with it is a new message.

A PUBREL for an identifier the client does not know gets PUBCOMP with reason 0x92. When the broker's Maximum Packet Size is 4, that PUBCOMP and the PUBREL with 0x92 above go out in their four-byte form without a reason code, because MQTT-3.2.2-15 forbids a larger packet.

### Handler failures

A handler that throws or rejects ends the session without PUBREC, as a QoS 1 handler does. The client forgets the identifier, so the PUBLISH that a resumed session receives again reaches the handler a second time, with `dup: true`. A handler that is still running when its connection ends decides by its own outcome. If it fulfills, the identifier stays recorded and the duplicate is not delivered. If it rejects after a later connection already answered the duplicate with PUBREC, the message is not delivered again.

### Flow control

A QoS 1 or QoS 2 handler makes the client advertise Receive Maximum 1. A QoS 2 publication holds that slot from its PUBLISH until the client has submitted its PUBCOMP. Another QoS 1 or QoS 2 PUBLISH before that ends the session with `ERR_MQTT_PROTOCOL` and DISCONNECT 0x93. One next PUBLISH may arrive while the PUBCOMP write is pending, and it is delivered when that write settles. A PUBREL that arrives while the handler still runs is a protocol error with reason 0x82. Identifiers that a resumed session brought along do not hold the slot, because the Receive Maximum starts over with each connection.

After `disconnect()` the client answers no PUBLISH and no PUBREL. An identifier that waits for PUBREL stays in the session state.

## Resumed sessions

A `sessionState`, or a reconnecting client with `resume: true`, keeps both directions across connections. [Resuming the session](reconnect.md#resuming-the-session)

| Stored when the connection ended | After a CONNACK with Session Present true |
| --- | --- |
| A QoS 2 publication without PUBREC | The client sends the PUBLISH again with DUP and its Packet Identifier. A `pubrec` event and then a `pubcomp` event report the broker's answers. |
| A QoS 2 publication with a PUBREC below 0x80 | The client sends only PUBREL. A `pubcomp` event reports the answer. The state dropped the payload when the PUBREC arrived. |
| The identifier of an inbound QoS 2 publication that got its handler call and no PUBREL | A duplicate PUBLISH gets PUBREC without a handler call, and the PUBREL gets PUBCOMP with reason 0. |

The client sends each PUBREL in the order the PUBRECs arrived, and then each PUBLISH in the order of the first writes (MQTT-4.6.0-1 and MQTT-4.6.0-4). Every continued exchange holds a quota slot until it ends. A CONNACK with Session Present false drops the stored publications and the inbound identifiers, and the `connected` event lists the publications in `dropped`. A stored QoS 2 PUBLISH conflicts with a broker whose Maximum QoS is now below 2, and the connection ends with `ERR_MQTT_SESSION_CONFLICT`. A stored PUBREL has no such conflict.

The session state lives in memory. A journal that survives a process restart is [#14](https://github.com/dvkam/mqtt/issues/14).

## Cost

These numbers come from Node 26.13.0 and an in-memory transport that answers each packet at once, so they show the client's own work. The heap bytes are the growth of `total_allocated_bytes` from `v8.getHeapStatistics()` over 200,000 publishes of a 16-byte text payload.

| Publish | Heap bytes per publish at 8398718, before QoS 2 | With QoS 2 |
| --- | ---: | ---: |
| QoS 0 | 3,011 | 3,011 |
| QoS 1 | 9,921 | 9,920 |
| QoS 1 with a session state | 10,377 | 10,377 |
| QoS 2 | | 18,651 |
| QoS 2 with a session state | | 19,383 |

A QoS 2 publish allocates 1.9 times the bytes of a QoS 1 publish, because it runs two acknowledged steps with a deadline each. On an otherwise idle machine it measured about 119,000 publishes per second, against about 196,000 at QoS 1. `test/bench/packed-qos1-qos2.ts` repeats the timing against an installed tarball. `MQTT_TEST_QOS` selects 1 or 2, and `MQTT_TEST_SESSION_STATE=1` adds a session state.

`publish(topic, payload, { qos: 2 })` is a runtime option, so a bundler cannot drop the exchange code and every client carries it. The packed browser bundle grew from 84,021 to 89,689 bytes, and from 21,135 to 22,484 bytes gzipped.

## Verification

`test/qos2-inbound.test.ts`, `test/qos2-publish.test.ts` and `test/qos2-resume.test.ts` drive the public clients over a scripted byte transport and assert the wire bytes. `test/qos2-codec.test.ts` pins the packet bytes against mqtt-packet. The packed `qos2.mjs` check runs both directions between two installed TCP clients and Mosquitto. A proxy then drops one PUBREC and one PUBREL, and the check asserts the packet a resumed session sends and one delivery per message. The QosTwoOutbound and QosTwoInbound models in `verification/` check the quota slot, the resume phase and one delivery per exchange on bounded instances.
