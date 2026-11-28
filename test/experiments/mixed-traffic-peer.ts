import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { generate, parser, type IPublishPacket, type Packet } from 'mqtt-packet';
import { WebSocket, WebSocketServer } from 'ws';
import { probePayload } from './mixed-traffic-ledger.js';

interface PeerOptions {
  transport: 'tcp' | 'websocket';
  echoDelayMs: number;
  readPauseMs: number;
  echoFault?: 'duplicate' | 'corrupt' | 'missing';
  onFailure: (reason: unknown) => void;
}

export async function startMixedTrafficPeer(options: Readonly<PeerOptions>) {
  const sockets = new Set<Socket | WebSocket>();
  const resumes = new Set<ReturnType<typeof setTimeout>>();
  const echoes: IPublishPacket[] = [];
  let echoTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let faultApplied = false;
  let subscribed = false;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const stats = {
    connects: 0,
    subscriptions: 0,
    pings: 0,
    disconnects: 0,
    controlRounds: 0,
    publications: 0,
    checksum: 0,
    echoesSent: 0,
    echoQueuePeak: 0,
  };
  const server = options.transport === 'tcp' ? createServer() : new WebSocketServer({ host: '127.0.0.1', port: 0 });

  function checkControl(command: 'subscribe' | 'pingreq'): void {
    const expected = (stats.controlRounds + 1) % 10 === 0 ? 'subscribe' : 'pingreq';
    if (command !== expected || stats.publications !== (stats.controlRounds + 1) * 8)
      throw new Error('Probe wire control order mismatch');
    stats.controlRounds++;
  }
  function attach(
    write: (bytes: Readonly<Buffer<Readonly<ArrayBufferLike>>>) => void,
    pause: () => void,
    resume: () => void,
    terminate: () => void,
  ) {
    const decoder = parser({ protocolVersion: 5 });
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `packet` is handed to `generate` of mqtt-packet, which declares the writable `Packet`. `ReadonlyDeep<Packet>` is not assignable to it (TS2345), so the fixture would have to copy the packet first.
    const send = (packet: Packet) => {
      write(generate(packet, { protocolVersion: 5 }));
    };
    const fail = (reason: unknown) => {
      options.onFailure(reason);
      terminate();
    };
    function scheduleEcho(): void {
      if (stopped || echoTimer !== undefined || echoes.length === 0) return;
      echoTimer = setTimeout(() => {
        echoTimer = undefined;
        const packet = echoes.shift();
        if (stopped || !packet) return;
        try {
          const fault = faultApplied ? undefined : options.echoFault;
          faultApplied = true;
          if (fault !== 'missing') {
            const payload = Buffer.isBuffer(packet.payload) ? packet.payload.toString('utf8') : packet.payload;
            send(fault === 'corrupt' ? { ...packet, payload: payload.slice(0, -1) + 'y' } : packet);
            stats.echoesSent++;
            if (fault === 'duplicate') {
              send(packet);
              stats.echoesSent++;
            }
          }
          scheduleEcho();
        } catch (reason) {
          fail(reason);
        }
      }, options.echoDelayMs);
    }
    decoder.on('error', fail);
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `packet` is queued in `echoes` and written back later through `send`, which hands it to `generate` of mqtt-packet, which declares the writable `Packet`. `ReadonlyDeep<Packet>` is not assignable to it (TS2345), so the fixture would have to copy the packet first.
    decoder.on('packet', (packet: Packet) => {
      try {
        switch (packet.cmd) {
          case 'connect':
            if (stats.connects !== 0 || packet.protocolVersion !== 5) throw new Error('Probe CONNECT mismatch');
            stats.connects++;
            send({ cmd: 'connack', reasonCode: 0, sessionPresent: false });
            break;
          case 'subscribe':
            if (packet.subscriptions.length !== 1 || packet.subscriptions[0]?.topic !== 'probe/echo')
              throw new Error('Probe subscription mismatch');
            if (subscribed) checkControl('subscribe');
            subscribed = true;
            stats.subscriptions++;
            send({ cmd: 'suback', messageId: packet.messageId, granted: [0] });
            break;
          case 'publish': {
            if (!subscribed || packet.qos !== 0 || packet.topic !== 'probe/echo' || !Buffer.isBuffer(packet.payload))
              throw new Error('Probe publication mismatch');
            const id = Math.floor(stats.publications / 8) * 16 + (stats.publications % 8);
            if (packet.payload.toString('utf8') !== probePayload(id)) throw new Error('Probe wire publication order mismatch');
            stats.publications++;
            stats.checksum += id;
            echoes.push(packet);
            stats.echoQueuePeak = Math.max(stats.echoQueuePeak, echoes.length);
            scheduleEcho();
            break;
          }
          case 'pingreq':
            checkControl('pingreq');
            stats.pings++;
            send({ cmd: 'pingresp' });
            break;
          case 'disconnect':
            stats.disconnects++;
            break;
          case 'auth':
          case 'connack':
          case 'pingresp':
          case 'puback':
          case 'pubcomp':
          case 'pubrec':
          case 'pubrel':
          case 'suback':
          case 'unsuback':
          case 'unsubscribe':
          default:
            throw new Error('Unexpected probe command');
        }
      } catch (reason) {
        fail(reason);
      }
    });
    return {
      push(bytes: Readonly<Buffer<Readonly<ArrayBufferLike>>>) {
        if (stopped) return;
        if (options.readPauseMs > 0 && resumeTimer === undefined) {
          pause();
          resumeTimer = setTimeout(() => {
            resumes.delete(resumeTimer!);
            resumeTimer = undefined;
            if (!stopped) resume();
          }, options.readPauseMs);
          resumes.add(resumeTimer);
        }
        try {
          decoder.parse(bytes);
        } catch (reason) {
          fail(reason);
        }
      },
      close() {
        if (resumeTimer !== undefined) {
          clearTimeout(resumeTimer);
          resumes.delete(resumeTimer);
        }
        resolveClosed();
      },
    };
  }
  if (server instanceof WebSocketServer) {
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. The handler calls `terminate`, `resume`, `pause` and `send` on `socket`, which is how this scripted peer answers, stalls or cuts off the client under test. The rule accepts only a read-only type, and that would be false for this parameter.
    server.on('connection', (socket) => {
      sockets.add(socket);

      const input = attach(
        (bytes: Readonly<Buffer<Readonly<ArrayBufferLike>>>) => {
          socket.send(bytes);
        },
        () => {
          socket.pause();
        },
        () => {
          socket.resume();
        },
        () => {
          socket.terminate();
        },
      );
      socket.on('error', options.onFailure);
      socket.on('close', () => {
        sockets.delete(socket);
        input.close();
      });
      socket.on('message', (bytes: Readonly<Buffer<Readonly<ArrayBufferLike>>>) => {
        if (Buffer.isBuffer(bytes)) input.push(bytes);
        else options.onFailure(new Error('Nonbinary probe frame'));
      });
    });
  } else {
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. The handler writes its replies to `socket` and adds it to `sockets`, which the peer uses later to reach the connection. The rule accepts only a read-only type, and that would be false for this parameter.
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.setNoDelay(true);

      const input = attach(
        (bytes: Readonly<Buffer<Readonly<ArrayBufferLike>>>) => {
          socket.write(bytes);
        },
        () => {
          socket.pause();
        },
        () => {
          socket.resume();
        },
        () => {
          socket.destroy();
        },
      );
      socket.on('error', options.onFailure);
      socket.on('close', () => {
        sockets.delete(socket);
        input.close();
      });
      socket.on('data', (bytes: Readonly<Buffer<Readonly<ArrayBufferLike>>>) => {
        input.push(typeof bytes === 'string' ? Buffer.from(bytes) : bytes);
      });
    });
    server.listen(0, '127.0.0.1');
  }
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected probe address');
  return {
    port: address.port,
    host: '127.0.0.1',
    url: 'ws://127.0.0.1:' + address.port,
    closed,
    snapshot: () => ({ ...stats, echoQueueFinal: echoes.length }),
    async close() {
      stopped = true;
      clearTimeout(echoTimer);
      for (const timer of resumes) clearTimeout(timer);
      for (const socket of sockets) {
        if (socket instanceof WebSocket) socket.terminate();
        else socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
