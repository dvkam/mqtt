import { once } from 'node:events';
import { generate, parser } from 'mqtt-packet';
import { WebSocketServer } from 'ws';

const publication = Uint8Array.of(0x30, 6, 0, 1, 97, 0, 104, 105);
const connack = Uint8Array.of(0x20, 3, 0, 0, 0);
const excess = Uint8Array.of(0x30, 7);

export async function startWebSocketPacketPeer(mode: string, pingReply?: readonly number[]) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
  const commands: string[] = [];
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The scripted peer owns mutable native WebSockets.
  server.on('connection', (socket) => {
    socket.on('error', () => {});
    const decoder = parser({ protocolVersion: 5 });
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The retained parser consumes mutable native Buffer objects.
    socket.on('message', (bytes) => {
      if (Buffer.isBuffer(bytes)) decoder.parse(bytes);
    });
    decoder.on('error', () => {
      socket.terminate();
    });
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The retained parser delivers mutable protocol packets.
    decoder.on('packet', (packet) => {
      commands.push(packet.cmd);
      if (packet.cmd === 'connect') {
        if (mode === 'limit-connect') socket.send(Uint8Array.of(0x20, 7));
        else if (mode === 'prefix-connect') socket.send(Uint8Array.from([...connack, ...excess]));
        else if (mode === 'eof-connect') {
          socket.send(Uint8Array.of(0x20));
          socket.close();
        } else if (mode === 'refusal-partial') {
          socket.send(Uint8Array.of(0x20, 3, 0, 135, 0, 0x30));
          socket.close();
        } else if (mode === 'tiny-messages' || mode === 'mqtt-split') {
          for (const byte of connack) socket.send(Uint8Array.of(byte));
        } else socket.send(connack);
      }
      if (packet.cmd === 'subscribe') {
        const reply = generate({ cmd: 'suback', messageId: packet.messageId, granted: [0] }, { protocolVersion: 5 });
        socket.send(mode === 'prefix-subscribe' ? Buffer.concat([reply, excess]) : Uint8Array.of(0x90, 7));
      }
      if (packet.cmd === 'publish') {
        if (mode === 'mqtt-split') {
          for (const byte of publication) socket.send(Uint8Array.of(byte));
        } else if (mode === 'ws-fragments') {
          socket.send(publication.subarray(0, 4), { fin: false });
          socket.send(publication.subarray(4), { fin: true });
        } else socket.send(publication);
      }
      if (packet.cmd === 'pingreq') {
        if (pingReply) socket.send(Uint8Array.from(pingReply));
        else if (mode === 'tiny-messages') {
          for (const byte of excess) socket.send(Uint8Array.of(byte));
        } else if (mode === 'fragmented-limit') {
          socket.send(Uint8Array.of(0x30, 0x80));
          socket.send(Uint8Array.of(1));
        } else if (mode === 'default-limit') socket.send(Uint8Array.of(0x30, 0x80, 0x80, 0x40));
        else if (mode === 'prefix-ping') socket.send(Uint8Array.from([0xd0, 0, ...excess]));
        else if (mode === 'limit-ping') socket.send(excess);
        else if (mode === 'eof-ping') {
          socket.send(Uint8Array.of(0xd0));
          socket.close();
        } else if (mode === 'eof-body') {
          socket.send(Uint8Array.of(0x30, 6, 0));
          socket.close();
        } else if (mode === 'partial-active') socket.send(Uint8Array.of(0xd0, 0, 0x30, 6, 0));
        else if (mode === 'partial-timeout') socket.send(Uint8Array.of(0x30, 6, 0));
        else if (mode === 'callback-abort') socket.send(Uint8Array.from([...publication, ...publication]));
        else if (mode === 'publication-prefix-limit') socket.send(Uint8Array.from([...publication, ...excess]));
        else if (mode === 'transfer-prefix') socket.send(Uint8Array.from([...publication, 0xd0, 0]));
        else if (mode === 'text') {
          socket.send('invalid MQTT text');
          socket.close();
        } else if (mode === 'native-limit-partial') {
          socket.send(Uint8Array.of(0x30, 6, 0));
          socket.send(new Uint8Array(9));
        } else if (mode === 'mqtt-split') {
          socket.send(Uint8Array.of(0xd0));
          socket.send(Uint8Array.of(0));
        } else socket.send(Uint8Array.of(0xd0, 0));
      }
      if (packet.cmd === 'disconnect') socket.close();
    });
  });
  return {
    url: 'ws://127.0.0.1:' + address.port,
    commands,
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
