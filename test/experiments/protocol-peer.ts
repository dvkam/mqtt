import { once } from 'node:events';
import { parser, generate, type Packet } from 'mqtt-packet';
import { WebSocketServer } from 'ws';

export async function startProtocolPeer() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
  const commands: string[] = [];
  const acknowledgments: { messageId: number | undefined; reasonCode: number }[] = [];
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The peer drives the native mutable WebSocket object.
  server.on('connection', (socket) => {
    const decoder = parser({ protocolVersion: 5 });
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The external parser consumes native Buffer objects.
    socket.on('message', (bytes) => {
      if (Buffer.isBuffer(bytes)) decoder.parse(bytes);
    });
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The external codec preserves its mutable Packet contract.
    decoder.on('packet', (packet: Packet) => {
      commands.push(packet.cmd);
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The external encoder consumes its mutable Packet union.
      const send = (reply: Packet) => {
        socket.send(generate(reply, { protocolVersion: 5 }));
      };
      if (packet.cmd === 'connect') send({ cmd: 'connack', reasonCode: 0, sessionPresent: false });
      if (packet.cmd === 'publish') {
        if (packet.qos === 1 && packet.messageId !== undefined) {
          send({ cmd: 'puback', messageId: packet.messageId, reasonCode: 0 });
        } else send(packet);
      }
      if (packet.cmd === 'subscribe') {
        send({
          cmd: 'suback',
          messageId: packet.messageId,
          granted: packet.subscriptions.map(({ qos }: Readonly<{ qos: number }>) => qos),
        });
        if (
          packet.subscriptions.some(
            ({ topic, qos }: Readonly<{ topic: string; qos: number }>) => topic === 'control/inbound' && qos === 1,
          )
        ) {
          send({ cmd: 'publish', topic: 'control/inbound', qos: 1, dup: false, retain: false, messageId: 23, payload: 'qos' });
        }
      }
      if (packet.cmd === 'puback') acknowledgments.push({ messageId: packet.messageId, reasonCode: packet.reasonCode ?? 0 });
      if (packet.cmd === 'pingreq') send({ cmd: 'pingresp' });
    });
  });
  return {
    url: 'ws://127.0.0.1:' + address.port,
    commands,
    acknowledgments,
    async close() {
      for (const socket of server.clients) socket.terminate();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
