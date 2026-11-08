import { once } from 'node:events';
import { generate, parser, type Packet } from 'mqtt-packet';
import { WebSocketServer } from 'ws';
import { afterEach, expect, test, vi } from 'vitest';
import { createBrowserClient } from '../src/browserClient.js';
import * as portable from '../src/portable.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function peer(reasonCode = 0, dropPing = false) {
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
      if (packet.cmd === 'connect') send({ cmd: 'connack', sessionPresent: false, reasonCode });
      if (packet.cmd === 'subscribe') send({ cmd: 'suback', messageId: packet.messageId, granted: [0] });
      if (packet.cmd === 'publish') send({ ...packet, payload: Buffer.from([0, 255, 128]) });
      if (packet.cmd === 'pingreq' && !dropPing) send({ cmd: 'pingresp' });
    });
  });
  return {
    url: 'ws://127.0.0.1:' + address.port,
    packets,
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

test('runs a public browser MQTT session with native codec and binary message payloads', async () => {
  const broker = await peer();
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  const onMessage = vi.fn<(packet: Extract<import('../src/codec.js').WirePacket, { cmd: 'publish' }>) => void>();
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
  const options = { url: broker.url, clientId: 'stable-handshake', timeoutMs: 3000 };
  try {
    const opening = createBrowserClient(options).connect();
    options.timeoutMs = Infinity;
    const client = await opening;
    await client.ping();
    await client.disconnect();
    expect(broker.packets.map(({ cmd }: Readonly<Packet>) => cmd)).toEqual(['connect', 'pingreq', 'disconnect']);
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
