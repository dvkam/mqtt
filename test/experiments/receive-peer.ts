import { once } from 'node:events';
import { generate, parser, type Packet } from 'mqtt-packet';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { ReadonlyDeep } from '../../src/util/bytes.js';

const publication = Uint8Array.of(0x30, 6, 0, 1, 0x61, 0, 0x68, 0x69);
const connack = Uint8Array.of(0x20, 3, 0, 0, 0);

export async function startReceivePeer() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
  server.on('connection', (socket: Readonly<WebSocket>, request: ReadonlyDeep<IncomingMessage>) => {
    const mode = new URL(request.url ?? '/', 'http://localhost').searchParams.get('mode');
    const decoder = parser({ protocolVersion: 5 });
    socket.on('message', (bytes: ReadonlyDeep<RawData>) => {
      if (Buffer.isBuffer(bytes)) decoder.parse(bytes);
    });
    decoder.on('packet', (packet: ReadonlyDeep<Packet>) => {
      if (packet.cmd === 'connect') {
        if (mode === 'oversized-connect') socket.send(Uint8Array.from([...connack, ...publication]));
        else if (mode === 'mqtt-split') {
          socket.send(connack.subarray(0, 3));
          socket.send(connack.subarray(3));
        } else socket.send(connack);
      }
      if (packet.cmd === 'subscribe') {
        const reply = generate({ cmd: 'suback', messageId: packet.messageId, granted: [0] }, { protocolVersion: 5 });
        socket.send(mode === 'suback-overflow' ? Buffer.concat([reply, publication]) : reply);
      }
      if (packet.cmd === 'pingreq') {
        if (mode === 'small-default-message-overflow') {
          socket.send(Uint8Array.from([0xd0, 0, ...publication, ...publication]));
          return;
        }
        if (mode === 'default-overflow') {
          const batch = new Uint8Array(2 * 1024 * 1024 + 2);
          batch.set([0xd0, 0]);
          for (let offset = 2; offset < batch.length; offset += publication.length) batch.set(publication, offset);
          socket.send(batch);
          return;
        }
        if (mode === 'partial-overflow') socket.send(Uint8Array.of(0x30));
        if (
          mode === 'ping-overflow' ||
          mode === 'partial-overflow' ||
          mode === 'ws-fragments-overflow' ||
          mode === 'stalled-close'
        ) {
          const excess = Uint8Array.from([0xd0, 0, ...publication]);
          if (mode === 'ws-fragments-overflow') {
            socket.send(excess.subarray(0, 5), { fin: false });
            socket.send(excess.subarray(5), { fin: true });
          } else socket.send(excess);
          if (mode === 'stalled-close') socket.pause();
        } else socket.send(Uint8Array.of(0xd0, 0));
      }
      if (packet.cmd === 'publish') {
        if (mode === 'batch-of-large-packets') {
          const payload = Buffer.alloc(600 * 1024, 0x61);
          const packet = { cmd: 'publish', qos: 0, retain: false, dup: false, payload } as const;
          const first = generate({ ...packet, topic: 'first' }, { protocolVersion: 5 });
          const second = generate({ ...packet, topic: 'second' }, { protocolVersion: 5 });
          socket.send(Buffer.concat([first, second]));
        } else if (mode === 'mqtt-split') {
          socket.send(publication.subarray(0, 4));
          socket.send(publication.subarray(4));
        } else if (mode === 'ws-fragments') {
          socket.send(publication.subarray(0, 4), { fin: false });
          socket.send(publication.subarray(4), { fin: true });
        } else if (mode === 'coalesced') socket.send(Uint8Array.from([...publication, ...publication]));
        else socket.send(publication);
      }
    });
  });
  return {
    url: 'ws://127.0.0.1:' + address.port,
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
