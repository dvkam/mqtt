import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { generate, parser, type Packet } from 'mqtt-packet';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import type { ReadonlyDeep } from '../../src/util/bytes.js';

export async function startCancellationPeer(kind: 'tcp' | 'websocket') {
  const commands: string[] = [];
  const { promise: pingSeen, resolve: sawPing } = Promise.withResolvers<void>();
  const { promise: peerClosed, resolve: sawClose } = Promise.withResolvers<void>();
  const sockets = new Set<Socket | WebSocket>();
  const packets = (write: (bytes: Readonly<Buffer<Readonly<ArrayBufferLike>>>) => void) => {
    const decoder = parser({ protocolVersion: 5 });
    decoder.on('packet', (packet: ReadonlyDeep<Packet>) => {
      commands.push(packet.cmd);
      if (packet.cmd === 'connect')
        write(generate({ cmd: 'connack', sessionPresent: false, reasonCode: 0 }, { protocolVersion: 5 }));
      if (packet.cmd === 'pingreq') sawPing();
    });
    return decoder;
  };
  const server = kind === 'tcp' ? createServer() : new WebSocketServer({ host: '127.0.0.1', port: 0 });
  if (server instanceof WebSocketServer) {
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. The handler calls `send` on `socket`, which is how this scripted peer answers, stalls or cuts off the client under test. The rule accepts only a read-only type, and that would be false for this parameter.
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', sawClose);
      const decoder = packets((bytes: Readonly<Buffer<Readonly<ArrayBufferLike>>>) => {
        socket.send(bytes);
      });
      socket.on('message', (bytes: ReadonlyDeep<RawData>) => {
        if (Buffer.isBuffer(bytes)) decoder.parse(bytes);
      });
    });
  } else {
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. The handler writes its replies to `socket` and adds it to `sockets`, which the peer uses later to reach the connection. The rule accepts only a read-only type, and that would be false for this parameter.
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', sawClose);
      const decoder = packets((bytes: Readonly<Buffer<Readonly<ArrayBufferLike>>>) => {
        socket.write(bytes);
      });
      socket.on('data', (bytes: string | Readonly<Buffer<Readonly<ArrayBufferLike>>>) => {
        decoder.parse(typeof bytes === 'string' ? Buffer.from(bytes) : bytes);
      });
    });
    server.listen(0, '127.0.0.1');
  }
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
  const drop = () => {
    for (const socket of sockets) {
      if ('terminate' in socket) socket.terminate();
      else socket.destroy();
    }
  };
  return {
    host: '127.0.0.1',
    port: address.port,
    url: 'ws://127.0.0.1:' + address.port,
    commands,
    pingSeen,
    peerClosed,
    drop,
    async close() {
      drop();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
