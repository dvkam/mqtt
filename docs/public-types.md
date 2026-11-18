# Public client types

Use `import type` for the named contracts. TypeScript 7.0.2 is the supported compiler floor for the preview. The repository builds with 7.1.0-beta. The packed CI job checks the installed Node and DOM-only browser consumers with both versions.

| Type                                                                              | Entry point                             | Contract                                                                                                                                     |
| --------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `TcpClientOptions`                                                                | `mqtt`                                  | Host, optional port, session options and cancellation signal                                                                                 |
| `WebSocketClientOptions`                                                          | `mqtt/ws`                               | URL, TLS and agent options, session options and local write budget                                                                           |
| `NodeMessage`, `NodeQosOneMessage`                                                | `mqtt`                                  | Received QoS 0 and 1 PUBLISH as a flat object with a mutable Buffer payload                                                                  |
| `BrowserClientOptions`                                                            | `mqtt/browser`                          | URL, session options, cancellation and independent byte and packet budgets                                                                   |
| `BrowserMessage`, `BrowserQosOneMessage`                                          | `mqtt/browser`                          | Received QoS 0 and 1 PUBLISH as a flat object with a mutable Uint8Array payload                                                              |
| `ClientDiagnostic`, `DiagnosticObserver`                                          | Both client entries and `mqtt/portable` | Optional packet command and connection state metadata                                                                                        |
| `SessionEnd`, `SessionEndObserver`                                                | Both client entries and `mqtt/portable` | First logical retirement and its optional observer                                                                                           |
| `ClientFactory`                                                                   | Both client entries                     | One cached connection attempt through `connect()`                                                                                            |
| `ClientSession`                                                                   | Both client entries                     | Subscribe, unsubscribe, text publish, ping and disconnect promises                                                                           |
| `BrowserSession`                                                                  | `mqtt/browser`                          | Alias for `ClientSession`                                                                                                                    |
| `PublishOptions`, `SubscribeOptions`                                              | Both client entries                     | QoS options. Only QoS 1 publish accepts a cancellation signal.                                                                               |
| `WebSocketOptions`                                                                | `mqtt/websocket`                        | Timeout and cancellation for opening a native MQTT WebSocket                                                                                 |
| `PortableOptions`, `PacketTransport`                                              | `mqtt/portable`                         | Experimental generic client and custom transport options. The packet contract uses the codec's packet model. See [custom transport contract](#custom-transport-contract).                                 |
| `ProtocolInputError`, `ProtocolInputCode`                                         | `mqtt/portable`                         | Decoder rejection passed to the optional transport protocol-error callback. Its readonly code is 0x81, 0x82 or 0x94. A custom transport can construct one. |

`onMessage` handles QoS 0. Register `onQosOneMessage` before requesting a QoS 1 subscription. Its message adds a packet identifier and a DUP flag, with the same platform-specific payload type. The client acknowledges the delivery after that handler succeeds. See [inbound QoS 1 delivery](qos1-receive.md).

Node and browser factories share a session interface. Their repeated `connect()` calls return the same promise. Browser declarations compile using DOM libraries with no Node ambient types. The requested client identifier belongs to factory options. The future session identity contract, including broker-assigned identifiers, belongs to #19 and #28.

## Received message fields

`onMessage` and `onQosOneMessage` receive one flat object on every platform. The Node and browser messages differ only in their byte types.

| Field                     | Type                                          | Notes                                                 |
| ------------------------- | --------------------------------------------- | ----------------------------------------------------- |
| `cmd`                     | `'publish'`                                   |                                                       |
| `topic`                   | `string`                                      |                                                       |
| `payload`                 | `Buffer` on Node, `Uint8Array` in the browser |                                                       |
| `qos`                     | `0`, or `1` in `onQosOneMessage`              |                                                       |
| `dup`                     | `false`, or `boolean` in `onQosOneMessage`    |                                                       |
| `retain`                  | `boolean`                                     |                                                       |
| `messageId`               | `number`                                      | Only in `onQosOneMessage`                             |
| `payloadFormatIndicator`  | `0` or `1`                                    |                                                       |
| `messageExpiryInterval`   | `number`                                      | Seconds                                               |
| `contentType`             | `string`                                      |                                                       |
| `responseTopic`           | `string`                                      |                                                       |
| `correlationData`         | `Buffer` on Node, `Uint8Array` in the browser |                                                       |
| `subscriptionIdentifiers` | `readonly number[]`                           | Wire order                                            |
| `userProperties`          | `readonly UserProperty[]`                     | `[key, value]` pairs in wire order. A key can repeat. |

The last seven fields are the PUBLISH properties, and `MessageProperties` names them. Its type parameter is the byte type. `NodeMessage` and `BrowserMessage` are the same received-message type with `Buffer` and `Uint8Array` bytes, so the two platforms cannot drift apart. A property the broker left out is an absent key. Both client entries export `MessageProperties` and `UserProperty`.

On Node, `payload` and `correlationData` are views of the one allocation the decoder made for the packet. Keeping either one keeps the whole packet in memory. Copy the bytes with `Buffer.from(message.payload)` to keep a payload for a long time.

### Change from the mqtt-packet shape

`NodeMessage` used to be mqtt-packet's `IPublishPacket` with a Buffer payload. It now matches `BrowserMessage`. `BrowserMessage` gained the six properties other than `userProperties`, which it dropped before.

| Before                                                                       | After                                                  |
| ---------------------------------------------------------------------------- | ------------------------------------------------------ |
| `message.properties?.contentType`                                            | `message.contentType`                                  |
| `message.properties?.responseTopic`                                          | `message.responseTopic`                                |
| `message.properties?.messageExpiryInterval`                                  | `message.messageExpiryInterval`                        |
| `message.properties?.correlationData`                                        | `message.correlationData`                              |
| `message.properties?.payloadFormatIndicator`, a `boolean`                    | `message.payloadFormatIndicator`, `0` or `1`           |
| `message.properties?.subscriptionIdentifier`, a `number` or `number[]`       | `message.subscriptionIdentifiers`, always a list       |
| `message.properties?.userProperties`, a map of `string` or `string[]` values | `message.userProperties`, ordered `[key, value]` pairs |
| `message.length`                                                             | Removed                                                |
| `message.messageId` and `message.properties?.topicAlias` on a QoS 0 message | Removed. Neither was ever set |
| `message.dup`, a `boolean` | `false` on a QoS 0 message, `boolean` on a QoS 1 message |

The old map kept the order of values under one key but lost the order between keys. The pairs keep the order the broker sent, which MQTT 5 requires a forwarder to keep (MQTT-3.3.2-18).

## Removed browser transport

Step 4 of [#171](https://github.com/dvkam/mqtt/issues/171) removed `openBrowserTransport` and its types `BrowserTransport`, `BrowserTransportOptions`, `BrowserCloseKind` and `WriteTraffic` from `mqtt/browser`. Use `createBrowserClient` for an MQTT session. For raw bytes, open the socket with `openMqttWebSocket` from `mqtt/websocket` and encode and decode with `mqtt/codec`. Step 5 makes the byte transport public and adds a migration table for every removed seam.

## Custom transport contract

`PacketTransport` speaks the packet model of `mqtt/codec`, so a custom transport can encode with `encodePacket` and decode with `PacketDecoder` without a translation layer.

- `send(packet)` receives a `ClientPacket`: CONNECT, SUBSCRIBE, UNSUBSCRIBE, PUBLISH, PUBACK, PINGREQ or DISCONNECT. `encodePacket` accepts every one. A PUBLISH payload is a `Uint8Array`, because the session encodes a string payload once.
- Set `supportsSharedSubscriptions: false` unless the transport passes `{ sharedSubscriptions: true }` to `encodePacket`. The session then refuses a `$share/` filter locally. Otherwise the encoder throws inside `send` and the session ends.
- `listen(onPacket, onClose, onProtocolError)` delivers `ReceivedPacket`: CONNACK, PUBACK, SUBACK, UNSUBACK, PINGRESP and DISCONNECT as the codec decodes them, and PUBLISH as a flat received message. The types leave out broker CONNECT, SUBSCRIBE, UNSUBSCRIBE and PINGREQ, so the transport rejects them itself.
- Pass a `ProtocolInputError` to `onProtocolError`, the third `listen` argument, for a malformed or wrong-direction packet. The session then sends DISCONNECT with its code once active. `PacketDecoder.pushBatch` returns its decode errors as `ProtocolInputError` where MQTT 5 assigns a reason code. Pass any other error to `onClose`.
- `PacketTransport`, `PortableOptions` and `connectPortable` take a byte type parameter instead of a message type. `PacketTransport<Buffer>` delivers Node Buffers, and the default is `Uint8Array`.
- `mqtt/portable` exports the `ProtocolInputError` class and the types `ClientPacket`, `BrokerPacket`, `ReceivedPacket`, `PublishMessage`, `MessageProperties` and `QosOneMessage`.

`test/types/custom-transport.ts` compiles this example against the built declarations.

```ts
import { encodePacket, PacketDecoder } from 'mqtt/codec';
import { connectPortable, ProtocolInputError, type PacketTransport } from 'mqtt/portable';

const decoder = new PacketDecoder();
const transport: PacketTransport = {
  // encodePacket refuses $share/ filters unless asked, so the session refuses them locally first.
  supportsSharedSubscriptions: false,
  async send(packet) {
    await channel.write(encodePacket(packet));
  },
  listen(onPacket, onClose, onProtocolError) {
    // A protocol error lets the session send DISCONNECT with its reason code. Any other error closes the session.
    const fail = (error: Error) => {
      if (error instanceof ProtocolInputError && onProtocolError) onProtocolError(error);
      else onClose(error);
    };
    return channel.onData((chunk) => {
      const batch = decoder.pushBatch(chunk);
      const packets = Array.isArray(batch) ? batch : batch.packets;
      for (const packet of packets) {
        if (packet.cmd === 'connect' || packet.cmd === 'subscribe' || packet.cmd === 'unsubscribe' || packet.cmd === 'pingreq') {
          fail(new ProtocolInputError('Unexpected MQTT packet from broker: ' + packet.cmd.toUpperCase(), 0x82));
          return;
        }
        if (packet.cmd !== 'publish') onPacket(packet);
        else if (packet.qos === 1) onPacket({ ...packet, dup: packet.dup ?? false, retain: packet.retain ?? false });
        else onPacket({ ...packet, qos: 0, dup: false, retain: packet.retain ?? false });
      }
      if (!Array.isArray(batch)) fail(batch.error);
    }, onClose);
  },
  close: async (force) => channel.close(force),
};
const session = await connectPortable(transport, { clientId: 'sensor-7' });
```

### Change from the mqtt-packet contract

This is a breaking change to the experimental `mqtt/portable` contract. Before, `send` and `listen` used mqtt-packet's `Packet` declarations.

| Before | After |
| --- | --- |
| `PacketTransport<Message>`, `PortableOptions<Message>` | `PacketTransport<Bytes>`, `PortableOptions<Bytes>` |
| CONNECT `clean`, `keepalive`, `properties.receiveMaximum`, `protocolVersion`, `protocolId` | `cleanStart`, `keepAlive`, `receiveMaximum`. The codec fixes MQTT 5. |
| SUBSCRIBE `subscriptions: [{ topic, qos }]` | `topics: [topic]`, `qos` |
| UNSUBSCRIBE `unsubscriptions` | `topics` |
| PUBLISH `payload` as a string | `payload` as a `Uint8Array`. A QoS 0 PUBLISH has no `qos` or `dup` field. |
| CONNACK and acknowledgment `properties.*` | The same names as top-level fields |
| User Properties as a map | Ordered `[key, value]` pairs |
| PUBACK `reasonCode` optional | Required |
| AUTH, PUBREC, PUBREL and PUBCOMP delivered to the session | Not part of the contract. The Node adapters reject AUTH with 0x82 and drop the QoS 2 handshake packets, as the session did. |
| `username` and `password` typed from mqtt-packet | `username?: string`, `password?: Uint8Array`. A `Buffer` still fits. |
| A delivered packet's `length` | Removed |

## Packed verification

Build and pack the package. Install the tarball and the pinned Node types into a clean ESM consumer. Run `test/packed/tcp-only-check.mjs` there before anything else, because it needs a consumer without `ws`. Then install `ws` at the version in `devDependencies`: the Node fixtures import `mqtt/ws`. Copy the Node fixture and its tsconfig from `test/packed`. The packed browser launcher copies the DOM-only fixture and uses the locked `typescript-stable` alias to check both projects. The normal build, Node packed step and browser launcher use the 7.1 beta compiler. The fixtures check contextual callbacks, mutable platform payloads, QoS discriminants and invalid publish options. The browser tsconfig uses an empty `types` list.

Run Publint 0.3.25 and Are the Types Wrong 0.18.5 against the tarball. Use the latter's `esm-only` profile for the package's ESM and bundler resolution modes. The profile excludes Node 10 and CommonJS resolution modes.

Refs #50.

## Session end

Set `onSessionEnd` on a TCP, Node WebSocket, browser or portable client to observe its first MQTT retirement. The observer runs after pending protocol work has been retired. It can run during MQTT connection setup if the transport has already reached the portable session. Use the `connect()` rejection for failures before that point.

- `{ kind: 'disconnect' }` means the local MQTT DISCONNECT write completed and won the retirement race. An application queue can drain its admitted messages. The native socket may still be closing, so await `disconnect()` for that result.
- `{ kind: 'error', error }` carries the original Error used to retire protocol work. A broker DISCONNECT, transport close, cancellation and protocol failure can all produce this outcome. Treat the error as application data. Use `onDiagnostic` for redacted command and state metadata.

The callback is queued once. Its return value never delays socket closure or protocol settlement, and thrown or rejected callbacks leave the first outcome intact. Application cancellation of a message consumer is separate from cancellation of its session.

`TcpTlsOptions` names the native CA, client certificate, key and servername settings accepted by `TcpClientOptions.tls`. See the [TCP TLS guide](tcp-tls.md).
