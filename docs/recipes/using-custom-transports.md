# Using a custom transport

Use `createTransportClient` when you already have a byte connection, such as a Node `Duplex` returned by a tunnel. The client handles MQTT framing and the session. Import from `mqtt` for Buffer payloads or from `mqtt/portable` for Uint8Array payloads.

This example adapts a connected `Duplex` in byte mode that emits `close` after the socket closes. Start the local broker, save the example as `duplex.ts`, and run `node duplex.ts` with Node 26 in the project where you installed the tarball. For an adapter that opens the socket in `open`, use its `signal` and `timeoutMs`. [Local broker setup](../running-the-sample.md)

```ts
import type { Duplex } from 'node:stream';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { createTransportClient, type ByteTransport } from 'mqtt';

function useDuplex(stream: Duplex): ByteTransport {
  return {
    name: 'Duplex',
    async open(inbound, { timeoutMs }) {
      stream.on('data', inbound.bytes).on('end', inbound.end).on('error', inbound.fail);
      const closed = new Promise<void>((resolve) => {
        stream.once('close', () => {
          inbound.end();
          resolve();
        });
      });
      return Promise.resolve({
        get bufferedBytes() {
          return stream.writableLength;
        },
        async write(bytes) {
          return new Promise<void>((resolve, reject) => {
            stream.write(bytes, (error) => {
              if (error) reject(error);
              else resolve();
            });
          });
        },
        async close(force) {
          const timer = setTimeout(() => {
            stream.destroy();
          }, timeoutMs);
          try {
            if (force) stream.destroy();
            else stream.end();
            await closed;
          } finally {
            clearTimeout(timer);
          }
        },
      });
    },
  };
}

const socket = createConnection({
  host: process.env['MQTT_HOST'] ?? '127.0.0.1',
  port: Number(process.env['MQTT_PORT'] ?? 1883),
});
try {
  await once(socket, 'connect', { signal: AbortSignal.timeout(3000) });
  const session = await createTransportClient(useDuplex(socket), { clientId: 'sensor-7' }).connect();
  try {
    await session.publish('sensor/reading', '24.1', { qos: 1 });
  } finally {
    await session.disconnect();
  }
} finally {
  socket.destroy();
}
console.log('Broker acknowledged the sensor/reading publication');
```

Use a new connection and a new factory for a retry. See [Public client types](../public-types.md#custom-transport-contract) for the transport contract and migration table. [`test/types/byte-transport.ts`](../../test/types/byte-transport.ts) compiles the same `useDuplex` adapter against the built declarations. [`test/packed/custom-transport.mjs`](../../test/packed/custom-transport.mjs) runs an equivalent JavaScript adapter against Mosquitto and checks an echoed publication.
