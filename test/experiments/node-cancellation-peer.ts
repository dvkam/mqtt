import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { generate, parser, type Packet } from 'mqtt-packet';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import type { ReadonlyDeep } from '../../src/util/bytes.js';

export async function startCancellationPeer(kind: 'tcp' | 'websocket') {
  const commands: string[] = [];
  let sawPing!: () => void;
  let sawClose!: () => void;
  const pingSeen = new Promise<void>((resolve) => {
    sawPing = resolve;
  });
  const peerClosed = new Promise<void>((resolve) => {
    sawClose = resolve;
  });
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
    server.on('connection', (socket: Readonly<WebSocket>) => {
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
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `socket` is typed `Socket`. `Readonly<Socket>` still fails the rule, and with `ReadonlyDeep<Socket>` this code stops compiling (TS2345, Argument of type '{ readonly [EventEmitter.captureRejectionSymbol]?: ((error: Error, event: string | symbol, ...args: ), so `socket` would need a copy or a second hand-written type before it is passed on. `Socket` is declared in `node:net`.
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
