# Using a custom transport

Use `createTransportClient` when you already have a byte connection, such as a Node `Duplex` returned by a tunnel. The client handles MQTT framing and the session. Import from `mqtt` for Buffer payloads or from `mqtt/portable` for Uint8Array payloads.

This example takes a connected `Duplex` in byte mode that emits `close` after the socket closes. For an adapter that opens the socket itself, use the `signal` and `timeoutMs` passed to `open`.

```ts
import type { Duplex } from 'node:stream';
import { createTransportClient, type ByteTransport } from 'mqtt';

function useDuplex(stream: Duplex): ByteTransport {
  return { name: 'Duplex',
    async open(inbound, { timeoutMs }) {
      stream.on('data', inbound.bytes).on('end', inbound.end).on('error', inbound.fail);
      const closed = new Promise<void>((resolve) => stream.once('close', () => { inbound.end(); resolve(); }));
      return { get bufferedBytes() { return stream.writableLength; },
        async write(bytes) { return new Promise((resolve, reject) => stream.write(bytes, (error) => error ? reject(error) : resolve())); },
        async close(force) {
          const timer = setTimeout(() => { stream.destroy(); }, timeoutMs);
          try { if (force) stream.destroy(); else stream.end(); await closed; }
          finally { clearTimeout(timer); }
        },
      };
    } };
}

const socket: Duplex = await openMyTunnel();
const session = await createTransportClient(useDuplex(socket), { clientId: 'sensor-7' }).connect();
try {
  await session.publish('sensor/reading', '24.1');
} finally {
  await session.disconnect();
}
```

Use a new connection and a new factory for a retry. See [Public client types](../public-types.md#custom-transport-contract) for the transport contract and migration table. The [packed fixture](../../test/packed/custom-transport.mjs) runs this adapter against Mosquitto and verifies an echoed publication.
