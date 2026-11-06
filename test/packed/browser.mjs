import { connectPortable } from 'mqtt/portable';

export async function trace() {
  let receive;
  let closed;
  let block = false;
  const packets = [];
  const messages = [];
  const transport = {
    async send(packet) {
      packets.push(packet.cmd);
      if (block) return new Promise(() => {});
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
  const options = { clientId: 'browser-ci', onMessage: (packet) => messages.push(packet.payload) };
  const client = await connectPortable(transport, options);
  await client.subscribe('ci/echo');
  await client.publish('ci/echo', 'hello');
  await client.disconnect();

  const interrupted = await connectPortable(transport, options);
  block = true;
  const pending = interrupted.publish('ci/echo', 'blocked');
  closed(new Error('closed before drain'));
  const outcome = await pending.then(
    () => 'resolved',
    (error) => error.message,
  );
  return { packets, messages, outcome };
}
