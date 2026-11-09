import { once } from 'node:events';
import { generate, parser, type Packet } from 'mqtt-packet';
import { WebSocketServer } from 'ws';
import { afterEach, expect, test, vi } from 'vitest';
import { createBrowserClient, type BrowserMessage } from '../src/browserClient.js';
import * as portable from '../src/portable.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function peer(
  reasonCode = 0,
  dropPing = false,
  properties?: Readonly<{ receiveMaximum?: number; maximumQoS?: number }>,
  unsubscribeReply?: readonly number[],
) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected TCP address');
  const packets: Packet[] = [];
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  server.on('connection', (socket) => {
    const decoder = parser({ protocolVersion: 5 });
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    socket.on('message', (bytes) => {
      if (Buffer.isBuffer(bytes)) decoder.parse(bytes);
    });
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    decoder.on('packet', (packet) => {
      packets.push(packet);
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
      const send = (value: Packet) => {
        socket.send(generate(value, { protocolVersion: 5 }));
      };
      if (packet.cmd === 'connect')
        send({
          cmd: 'connack',
          sessionPresent: false,
          reasonCode,
          properties,
        });
      if (packet.cmd === 'subscribe') send({ cmd: 'suback', messageId: packet.messageId, granted: [0] });
      if (packet.cmd === 'unsubscribe') {
        if (unsubscribeReply) socket.send(Buffer.from(unsubscribeReply));
        else send({ cmd: 'unsuback', messageId: packet.messageId, granted: [17] });
      }
      if (packet.cmd === 'publish') send({ ...packet, payload: Buffer.from([0, 255, 128]) });
      if (packet.cmd === 'pingreq' && !dropPing) send({ cmd: 'pingresp' });
    });
  });
  return {
    url: 'ws://127.0.0.1:' + address.port,
    packets,
    sendWire(bytes: readonly number[]) {
      for (const socket of server.clients) socket.send(Buffer.from(bytes));
    },
    async disconnect() {
      const closed: Promise<unknown[]>[] = [];
      for (const socket of server.clients) {
        closed.push(once(socket, 'close'));
        socket.send(Buffer.from([0xe0, 0]));
      }
      await Promise.all(closed);
    },
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

test('forwards broker limits and PUBACK to the portable session', async () => {
  const broker = await peer(0, false, { receiveMaximum: 1, maximumQoS: 0 });
  const connect = portable.connectPortable;
  const received: unknown[] = [];
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The test observes the existing mutable packet transport contract.
  vi.spyOn(portable, 'connectPortable').mockImplementation(async (transport, options) => {
    const listen = transport.listen.bind(transport);
    transport.listen = (onPacket, onClose) =>
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Forward the adapter's original mutable packets to the session.
      listen((packet) => {
        if (packet.cmd === 'connack' || packet.cmd === 'puback') received.push(packet);
        onPacket(packet);
      }, onClose);
    return connect(transport, options);
  });
  try {
    const client = await createBrowserClient({ url: broker.url, clientId: 'receive-maximum' }).connect();
    broker.sendWire([0x40, 3, 0, 7, 0x97]);
    await client.ping();
    expect(received).toMatchObject([
      { cmd: 'connack', properties: { receiveMaximum: 1, maximumQoS: 0 } },
      { cmd: 'puback', messageId: 7, reasonCode: 0x97 },
    ]);
    await client.disconnect();
  } finally {
    await broker.close();
  }
});

test('keeps a decoded QoS 1 publication out of the QoS 0 message callback', async () => {
  const broker = await peer(0, true);
  const onMessage = vi.fn<() => void>();
  try {
    const client = await createBrowserClient({ url: broker.url, clientId: 'qos-1-inbound', onMessage }).connect();
    const pending = client.ping();
    broker.sendWire([0x32, 7, 0, 1, 97, 0, 1, 0, 255]);
    await expect(pending).rejects.toThrow('Unsupported incoming MQTT QoS 1');
    expect(onMessage).not.toHaveBeenCalled();
  } finally {
    await broker.close();
  }
});

test('runs a public browser MQTT session with native codec and binary message payloads', async () => {
  const broker = await peer();
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  const onMessage = vi.fn<(packet: BrowserMessage) => void>();
  try {
    const factory = createBrowserClient({ url: broker.url, clientId: 'browser', onMessage });
    const opening = factory.connect();
    expect(factory.connect()).toBe(opening);
    const client = await opening;
    await client.subscribe('a');
    await client.publish('a', 'hello');
    await vi.waitFor(() => {
      expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ topic: 'a', payload: Uint8Array.of(0, 255, 128) }));
    });
    await client.ping();
    await client.disconnect();
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    expect(broker.packets.map(({ cmd }) => cmd)).toEqual(['connect', 'subscribe', 'publish', 'pingreq', 'disconnect']);
  } finally {
    await broker.close();
  }
});

test('routes normal broker DISCONNECT through the shared session', async () => {
  const broker = await peer();
  try {
    const client = await createBrowserClient({ url: broker.url, clientId: 'broker-disconnect' }).connect();
    await broker.disconnect();
    await expect(client.ping()).rejects.toMatchObject({ message: 'MQTT broker disconnected', code: 0 });
  } finally {
    await broker.close();
  }
});

test('rejects refused browser CONNECT and closes the attempt', async () => {
  const broker = await peer(0x87);
  try {
    await expect(createBrowserClient({ url: broker.url, clientId: 'refused' }).connect()).rejects.toMatchObject({ code: 0x87 });
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    expect(broker.packets.map(({ cmd }) => cmd)).toEqual(['connect']);
  } finally {
    await broker.close();
  }
});

test('keeps the opening timeout when caller options change during the browser handshake', async () => {
  const broker = await peer();
  const options = {
    url: broker.url,
    clientId: 'stable-handshake',
    timeoutMs: 3000,
    maxPendingPublishes: 1,
    maxPendingPublishBytes: 128,
  };
  try {
    const opening = createBrowserClient(options).connect();
    options.timeoutMs = Infinity;
    options.maxPendingPublishes = 0;
    options.maxPendingPublishBytes = 0;
    const client = await opening;
    await client.ping();
    await client.disconnect();
    expect(broker.packets.map(({ cmd }: Readonly<Pick<Packet, 'cmd'>>) => cmd)).toEqual(['connect', 'pingreq', 'disconnect']);
  } finally {
    await broker.close();
  }
});

test('active abort settles a pending browser ping and rejects later writes', async () => {
  const broker = await peer(0, true);
  const controller = new AbortController();
  try {
    const client = await createBrowserClient({ url: broker.url, clientId: 'abort', signal: controller.signal }).connect();
    const pending = client.ping();
    const reason = new Error('cancel browser session');
    const result = (async () => {
      await expect(pending).rejects.toBe(reason);
    })();
    controller.abort(reason);
    await result;
    await expect(client.publish('a', 'late')).rejects.toBe(reason);
  } finally {
    await broker.close();
  }
});

test('rejects cancellation during portable-to-browser connection handoff', async () => {
  const broker = await peer();
  const controller = new AbortController();
  const reason = new Error('cancel final handoff');
  const connect = portable.connectPortable;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  vi.spyOn(portable, 'connectPortable').mockImplementation(async (transport, options) => {
    const client = await connect(transport, options);
    controller.abort(reason);
    return client;
  });
  try {
    await expect(createBrowserClient({ url: broker.url, clientId: 'handoff', signal: controller.signal }).connect()).rejects.toBe(
      reason,
    );
  } finally {
    await broker.close();
  }
});

test('ping timeout retires locally without waiting for a second native-close deadline', async () => {
  class StalledSocket extends EventTarget {
    static OPEN = 1;
    static CLOSING = 2;
    protocol = 'mqtt';
    readyState = 1;
    binaryType = 'arraybuffer';
    bufferedAmount = 0;
    constructor() {
      super();
      queueMicrotask(() => {
        this.dispatchEvent(new Event('open'));
      });
    }
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    send(bytes: Uint8Array) {
      if (bytes[0] === 0x10)
        queueMicrotask(() => {
          this.dispatchEvent(new MessageEvent('message', { data: Uint8Array.of(0x20, 3, 0, 0, 0).buffer }));
        });
    }
    close() {
      this.readyState = 2;
    }
  }
  vi.stubGlobal('WebSocket', StalledSocket);
  const client = await createBrowserClient({ url: 'ws://localhost', clientId: 'deadline', timeoutMs: 50 }).connect();
  vi.useFakeTimers();
  let settled = false;
  const result = client.ping().catch((error: unknown) => {
    settled = true;
    return error;
  });
  await vi.advanceTimersByTimeAsync(50);
  expect(settled).toBe(true);
  await expect(result).resolves.toMatchObject({ message: 'MQTT operation timed out' });
  await vi.advanceTimersByTimeAsync(50);
});

test('browser publication pressure leaves native admission room for unsubscribe, ping and disconnect', async () => {
  const broker = await peer();
  try {
    const options = { url: broker.url, clientId: 'reserve', maxBufferedBytes: 32, reservedControlBytes: 8 };
    const opening = createBrowserClient(options).connect();
    options.maxBufferedBytes = 1;
    options.reservedControlBytes = 1;
    const client = await opening;
    const queued = vi.spyOn(WebSocket.prototype, 'bufferedAmount', 'get').mockReturnValue(18);
    await client.publish('a', '');
    queued.mockReturnValue(24);
    await expect(client.publish('a', '')).rejects.toThrow('WebSocket write budget exceeded');
    await client.unsubscribe('a');
    await client.ping();
    await client.disconnect();
    expect(broker.packets.map(({ cmd }: Readonly<Pick<Packet, 'cmd'>>) => cmd)).toEqual([
      'connect',
      'publish',
      'unsubscribe',
      'pingreq',
      'disconnect',
    ]);
  } finally {
    await broker.close();
  }
});

test.each(['subscribe', 'unsubscribe'] as const)(
  'rejects unsupported browser shared filters before %s admission',
  async (command) => {
    const broker = await peer();
    try {
      const client = await createBrowserClient({ url: broker.url, clientId: 'shared-filter' }).connect();
      await expect(client[command]('$share/group/a')).rejects.toThrow('Unsupported shared subscription');
      await client.ping();
      await client[command]('a');
      expect(broker.packets[2]).toMatchObject({ cmd: command, messageId: 1 });
      await client.disconnect();
    } finally {
      await broker.close();
    }
  },
);

test.each([
  { bytes: [0xb0, 5, 0, 1, 0, 0, 17, 0xc0, 0], code: 0x82 },
  { bytes: [0xb0, 4, 0, 1, 0, 1], code: 0x82 },
  { bytes: [0xb0, 3, 0, 1, 0], code: 0x81 },
  { bytes: [0xb0, 4, 0, 0, 0, 17], code: 0x82 },
])(
  'reports an invalid UNSUBACK through the browser wire path with $code',
  async ({ bytes, code }: Readonly<{ bytes: readonly number[]; code: number }>) => {
    const broker = await peer(0, false, undefined, [...bytes, 0x30, 4, 0, 1, 97, 0]);
    try {
      const onMessage = vi.fn<() => void>();
      const client = await createBrowserClient({ url: broker.url, clientId: 'unsuback-protocol', onMessage }).connect();
      const failure = await client.unsubscribe('a').catch((reason: unknown) => reason);
      expect(failure).toMatchObject({ code });
      await expect(client.ping()).rejects.toBe(failure);
      await expect.poll(() => broker.packets[2]).toMatchObject({ cmd: 'disconnect', reasonCode: code });
      expect(onMessage).not.toHaveBeenCalled();
    } finally {
      await broker.close();
    }
  },
);
