import { encodePacket, PacketDecoder } from 'mqtt/codec';
import { createTransportClient } from 'mqtt/portable';

export async function trace() {
  /** @type {import('mqtt/portable').ByteInbound | undefined} */
  let inbound;
  let block = false;
  /** @type {string[]} */
  const packets = [];
  /** @type {string[]} */
  const messages = [];
  /** @type {import('mqtt/portable').ByteTransport} */
  const transport = {
    name: 'Scripted browser peer',
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The peer keeps the inbound endpoint for a simulated failure.
    async open(input) {
      inbound = input;
      const decoder = new PacketDecoder();
      let release = () => {};
      return Promise.resolve({
        bufferedBytes: 0,
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The writer receives the core's mutable bytes.
        async write(bytes) {
          const [packet] = decoder.push(bytes);
          if (packet === undefined) throw new Error('Missing request packet');
          packets.push(packet.cmd);
          if (block)
            return new Promise((resolve) => {
              release = resolve;
            });
          if (packet.cmd === 'connect') input.bytes(Uint8Array.of(0x20, 3, 0, 0, 0));
          if (packet.cmd === 'subscribe') input.bytes(encodePacket({ cmd: 'suback', messageId: packet.messageId, granted: [0] }));
          if (packet.cmd === 'publish') input.bytes(bytes);
        },
        async close() {
          release();
          return Promise.resolve();
        },
      });
    },
  };
  /** @type {Parameters<typeof createTransportClient>[1]} */
  const options = {
    clientId: 'browser-ci',
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    onMessage: (/** @type {Readonly<{payload: Uint8Array}>} */ packet) => {
      messages.push(new TextDecoder().decode(packet.payload));
    },
  };
  const client = await createTransportClient(transport, options).connect();
  await client.subscribe('ci/\u0000invalid').then(
    () => {
      throw new Error('Expected invalid filter rejection');
    },
    (/** @type {unknown} */ error) => {
      if (!(error instanceof Error) || error.message !== 'Invalid MQTT topic filter') throw error;
    },
  );
  await client.subscribe('ci/echo');
  await client.publish('ci/echo', 'hello');
  await client.disconnect();

  const interrupted = await createTransportClient(transport, options).connect();
  block = true;
  const pending = interrupted.publish('ci/echo', 'blocked');
  if (!inbound) throw new Error('Missing inbound endpoint');
  inbound.fail(new Error('closed before drain'));
  const outcome = await pending.then(
    () => 'resolved',
    (/** @type {unknown} */ error) => {
      if (!(error instanceof Error)) throw new Error('Expected transport failure');
      return error.message;
    },
  );
  return { packets, messages, outcome };
}
