import type { ConnectOptions } from '../../dist/interface/connectOptions.js';
import type { PacketTransport } from '../../dist/portable.js';
import { createBrowserClient, openBrowserTransport } from '../../dist/browser.js';

export const packetTransport: PacketTransport = {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types, typescript/require-await -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  async send(packet) {
    if (packet.cmd === 'publish') packet.payload = 'adapter-owned payload';
  },
  listen(_receive, onClose) {
    const error = new Error('transport failure');
    onClose(error);
    return () => {};
  },
  async close() {},
};

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
export const customStreamFactory: ConnectOptions['customStreamFactory'] = (options) => {
  options.clientId = 'factory-normalized';
  throw new Error('Compile-only fixture');
};

export const browserFactory = createBrowserClient({
  url: 'wss://localhost/mqtt',
  clientId: 'mutable-consumer',
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  onMessage(message) {
    message.topic = 'consumer-normalized';
    message.payload = new Uint8Array();
  },
});

export async function mutableBrowserCallbacks() {
  const transport = await openBrowserTransport('wss://localhost/mqtt', {
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    onBytes(bytes) {
      bytes[0] = 0;
    },
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    onClose(reason) {
      reason.message = 'consumer annotation';
    },
  });
  await transport.close();
}
