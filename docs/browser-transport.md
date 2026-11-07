# Browser byte transport

Import `openBrowserTransport` from `mqtt/browser`. It opens the browser's native WebSocket with the `mqtt` subprotocol and delivers binary messages as `Uint8Array`.

```ts
import { openBrowserTransport } from 'mqtt/browser';
import { encodePacket, PacketDecoder } from 'mqtt/codec';

const decoder = new PacketDecoder();

const transport = await openBrowserTransport('wss://broker.example/mqtt', {
  onBytes(bytes) {
    for (const packet of decoder.push(bytes)) console.log(packet.cmd);
  },
  onClose(reason) {
    console.log(reason.message);
  },
  maxBufferedBytes: 1024 * 1024,
  timeoutMs: 3000,
});

transport.send(encodePacket({ cmd: 'connect', clientId: 'example' }));
```

The example sends CONNECT. A session must accept CONNACK before publishing or subscribing and match later acknowledgments. Call `transport.close()` when the session ends. The codec preview profile is documented in docs/codec.md. The public client preview in docs/browser-client.md owns these session operations.

`send` checks the native `bufferedAmount` plus the new message against the budget, then calls native `send`. A successful call means local queue admission. The budget excludes browser framing, receive buffers, kernel buffers and application allocations.

The signal cancels opening and remains attached during the active transport. Close, abort, a socket error or a text message retires delivery and further sends. `onClose` runs once. Its second argument is a `BrowserCloseKind`, exported from `mqtt/browser`. The values are `remote` for a native close, `local` for an explicit close, `abort` for cancellation and `error` for a socket, frame or byte-handler error. The first retirement owns the notification, even if a native close follows. A captured message callback also checks retirement before delivering bytes.

The public browser client completes its decoder during this notification. It reports truncated input on remote EOF and preserves the initiating reason for other retirements. Users of the byte transport own their decoder completion policy.

`close` returns the same promise on repeated calls. It waits for the native close event and rejects at its deadline. If `onClose` throws, the close promise reports that error after native closure or the deadline. Native browser WebSocket has no force-termination method. A suspended page can delay timers.

The browser owns TLS trust, certificate selection and proxy settings. Node-specific CA, key and proxy-agent options belong to the Node adapter.
