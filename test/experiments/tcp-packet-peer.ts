import { createServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { generate, parser } from 'mqtt-packet';

const publication = Uint8Array.of(0x30, 6, 0, 1, 97, 0, 104, 105);
const connack = Uint8Array.of(0x20, 3, 0, 0, 0);
const excess = Uint8Array.of(0x30, 7);

export async function startTcpPacketPeer(mode: string) {
  const sockets = new Set<Socket>();
  const commands: string[] = [];
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The peer owns a mutable native socket.
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.setNoDelay(true);
    socket.once('close', () => {
      sockets.delete(socket);
    });
    // Rejecting an intentionally invalid response can reset the peer socket.
    socket.on('error', () => {});
    const decoder = parser({ protocolVersion: 5 });
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The scripted peer consumes native mutable socket buffers.
    socket.on('data', (bytes) => {
      decoder.parse(typeof bytes === 'string' ? Buffer.from(bytes) : bytes);
    });
    decoder.on('error', () => {
      socket.destroy();
    });
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The retained parser exposes mutable packet objects.
    decoder.on('packet', (packet) => {
      commands.push(packet.cmd);
      if (packet.cmd === 'connect') {
        if (mode === 'limit-connect') socket.write(Uint8Array.of(0x20, 7));
        else if (mode === 'prefix-connect') socket.write(Uint8Array.from([...connack, ...excess]));
        else if (mode === 'eof-connect') socket.end(Uint8Array.of(0x20));
        else if (mode === 'refusal-partial') socket.end(Uint8Array.of(0x20, 3, 0, 135, 0, 0x30));
        else {
          socket.write(connack);
          if (mode === 'blocked-write-eof') {
            socket.pause();
            setTimeout(() => {
              if (!socket.destroyed) socket.end(Uint8Array.of(0x30, 6, 0));
            }, 20);
          }
        }
      }
      if (packet.cmd === 'subscribe') {
        const reply = generate({ cmd: 'suback', messageId: packet.messageId, granted: [0] }, { protocolVersion: 5 });
        if (mode === 'limit-subscribe') socket.write(Uint8Array.of(0x90, 7));
        else socket.write(mode === 'prefix-subscribe' ? Buffer.concat([reply, excess]) : reply);
      }
      if (packet.cmd === 'publish') socket.write(publication);
      if (packet.cmd === 'pingreq') {
        if (mode === 'limit-ping') socket.write(excess);
        else if (mode === 'prefix-ping') socket.write(Uint8Array.from([0xd0, 0, ...excess]));
        else if (mode === 'fragmented-limit') {
          socket.write(Uint8Array.of(0x30, 0x80));
          setImmediate(() => {
            if (!socket.destroyed) socket.write(Uint8Array.of(1));
          });
        } else if (mode === 'default-limit') socket.write(Uint8Array.of(0x30, 0x80, 0x80, 0x40));
        else if (mode === 'eof-ping') socket.end(Uint8Array.of(0xd0));
        else if (mode === 'eof-body') socket.end(Uint8Array.of(0x30, 6, 0));
        else if (mode === 'partial-active') socket.write(Uint8Array.of(0xd0, 0, 0x30, 6, 0));
        else if (mode === 'partial-timeout') socket.write(Uint8Array.of(0x30, 6, 0));
        else if (mode === 'callback-abort') socket.write(Uint8Array.from([...publication, ...publication]));
        else if (mode === 'publish-prefix-limit') socket.write(Uint8Array.from([...publication, ...excess]));
        else if (mode === 'transfer-prefix-ping') socket.write(Uint8Array.from([...publication, 0xd0, 0]));
        else socket.write(Uint8Array.of(0xd0, 0));
      }
      if (packet.cmd === 'disconnect') socket.end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
  return {
    host: '127.0.0.1',
    port: address.port,
    commands,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
