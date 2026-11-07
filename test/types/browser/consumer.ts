import { createBrowserClient, openBrowserTransport } from 'mqtt/browser';
import { encodePacket, PacketDecoder } from 'mqtt/codec';

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
export async function checkBrowserTypes(signal: AbortSignal) {
  const client = await createBrowserClient({
    url: new URL('wss://localhost/mqtt'),
    clientId: 'browser-types',
    signal,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
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
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    onBytes(bytes) {
      decoder.push(bytes);
    },
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    onClose(reason) {
      reason.message.toLowerCase();
    },
  });
  transport.send(encodePacket({ cmd: 'connect', clientId: 'types' }));
  await transport.close();
}
