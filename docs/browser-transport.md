# Browser byte transport

Import `openBrowserTransport` from `mqtt/browser`. It opens the browser's native WebSocket with the `mqtt` subprotocol and delivers binary messages as `Uint8Array`.

```ts
import { openBrowserTransport } from 'mqtt/browser';

const transport = await openBrowserTransport('wss://broker.example/mqtt', {
  onBytes(bytes) {
    // Feed the bytes to the MQTT decoder.
    console.log(bytes.byteLength);
  },
  onClose(reason) {
    console.log(reason.message);
  },
  maxBufferedBytes: 1024 * 1024,
  timeoutMs: 3000,
});

transport.send(Uint8Array.of(0xc0, 0));
await transport.close();
```

The example sends an MQTT PINGREQ wire vector. A real MQTT session must first send CONNECT and accept CONNACK. Codec integration and the browser client API remain under #37 and #8.

`send` checks the native `bufferedAmount` plus the new message against the budget, then calls native `send`. A successful call means local queue admission. The budget excludes browser framing, receive buffers, kernel buffers and application allocations.

The signal cancels opening and remains attached during the active transport. Close, abort, a socket error or a text message retires delivery and further sends. `onClose` runs once. A captured message callback also checks retirement before delivering bytes.

`close` returns the same promise on repeated calls. It waits for the native close event and rejects at its deadline. If `onClose` throws, the close promise reports that error after native closure or the deadline. Native browser WebSocket has no force-termination method. A suspended page can delay timers.

The browser owns TLS trust, certificate selection and proxy settings. Node-specific CA, key and proxy-agent options belong to the Node adapter.
