import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { generate, parser } from 'mqtt-packet';
import { WebSocketServer, type WebSocket } from 'ws';

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
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The scripted writer accepts the external codec's native Buffer result.
  const packets = (write: (bytes: Buffer) => void) => {
    const decoder = parser({ protocolVersion: 5 });
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The external parser preserves its mutable packet contract.
    decoder.on('packet', (packet) => {
      commands.push(packet.cmd);
      if (packet.cmd === 'connect')
        write(generate({ cmd: 'connack', sessionPresent: false, reasonCode: 0 }, { protocolVersion: 5 }));
      if (packet.cmd === 'pingreq') sawPing();
    });
    return decoder;
  };
  const server = kind === 'tcp' ? createServer() : new WebSocketServer({ host: '127.0.0.1', port: 0 });
  if (server instanceof WebSocketServer) {
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture drives native mutable WebSocket objects.
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', sawClose);
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture forwards the codec's native Buffer to its socket.
      const decoder = packets((bytes) => {
        socket.send(bytes);
      });
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The external parser accepts native Buffer input.
      socket.on('message', (bytes) => {
        if (Buffer.isBuffer(bytes)) decoder.parse(bytes);
      });
    });
  } else {
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture drives native mutable TCP sockets.
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('error', () => {});
      socket.on('close', sawClose);
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture forwards the codec's native Buffer to its socket.
      const decoder = packets((bytes) => {
        socket.write(bytes);
      });
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The external parser accepts native Buffer input.
      socket.on('data', (bytes) => {
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
