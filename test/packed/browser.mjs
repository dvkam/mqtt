import { connectPortable } from 'mqtt/portable';

export async function trace() {
  /** @type {Parameters<import('mqtt/portable').PacketTransport['listen']>[0]} */
  let receive;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  /** @type {(error: Error) => void} */
  let closed = () => {
    throw new Error('Missing close observer');
  };
  let block = false;
  /** @type {string[]} */
  const packets = [];
  /** @type {string[]} */
  const messages = [];
  /** @type {import('mqtt/portable').PacketTransport} */
  const transport = {
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    async send(packet) {
      packets.push(packet.cmd);
      if (block) await new Promise(() => {});
      if (packet.cmd === 'connect') receive({ cmd: 'connack', sessionPresent: false, reasonCode: 0 });
      if (packet.cmd === 'subscribe') receive({ cmd: 'suback', messageId: packet.messageId, granted: [0] });
      if (packet.cmd === 'publish') receive(packet);
    },
    listen(onPacket, onClose) {
      receive = onPacket;
      closed = onClose;
      return () => {};
    },
    async close() {},
  };
  /** @type {Parameters<typeof connectPortable>[1]} */
  const options = {
    clientId: 'browser-ci',
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    onMessage: (packet) => {
      if (typeof packet.payload !== 'string') throw new Error('Expected fixture payload');
      messages.push(packet.payload);
    },
  };
  const client = await connectPortable(transport, options);
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

  const interrupted = await connectPortable(transport, options);
  block = true;
  const pending = interrupted.publish('ci/echo', 'blocked');
  closed(new Error('closed before drain'));
  const outcome = await pending.then(
    () => 'resolved',
    (/** @type {unknown} */ error) => {
      if (!(error instanceof Error)) throw new Error('Expected transport failure');
      return error.message;
    },
  );
  return { packets, messages, outcome };
}
