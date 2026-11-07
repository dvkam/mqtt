import { createBrowserClient, openBrowserTransport } from 'mqtt/browser';
import { encodePacket, PacketDecoder } from 'mqtt/codec';

export async function checkBrowserTypes(signal: AbortSignal) {
  const client = await createBrowserClient({
    url: new URL('wss://localhost/mqtt'),
    clientId: 'browser-types',
    signal,
    onMessage(message) {
      const payload: Uint8Array = message.payload;
      payload.byteLength.toFixed();
    },
  }).connect();
  await client.subscribe('a');
  await client.publish('a', 'hello');
  await client.ping();
  await client.disconnect();
  const decoder = new PacketDecoder();
  const transport = await openBrowserTransport('wss://localhost/mqtt', {
    onBytes(bytes) {
      decoder.push(bytes);
    },
    onClose(reason) {
      reason.message.toLowerCase();
    },
  });
  transport.send(encodePacket({ cmd: 'connect', clientId: 'types' }));
  await transport.close();
}
