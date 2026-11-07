import { EventEmitter, getEventListeners, once } from 'node:events';
import { createServer, Socket } from 'node:net';
import { setTimeout } from 'node:timers/promises';
import { generate, parser, type Packet } from 'mqtt-packet';
import { expect, test, vi } from 'vitest';
import { createTcpClient } from '../src/index.js';

const connack: Packet = { cmd: 'connack', reasonCode: 0, sessionPresent: false };

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
async function broker(reply: (packet: Packet) => Packet | undefined) {
  const sockets = new Set<Socket>();
  const commands: string[] = [];
  const events = new EventEmitter();
  let opened = 0;
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      events.emit('peer-close');
    });
    opened++;
    const codec = { protocolVersion: 5 };
    const decoder = parser(codec);
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    socket.on('data', (chunk) => {
      decoder.parse(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    });
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    decoder.on('packet', (packet) => {
      commands.push(packet.cmd);
      events.emit(packet.cmd, socket);
      const response = reply(packet);
      if (response) socket.write(generate(response, codec));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address');
  return {
    options: { host: '127.0.0.1', port: address.port, clientId: 'tcp-tracer' },
    opened: () => opened,
    commands,
    events,
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

test('opens no TCP connection during construction and one when connect is called', async () => {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  const peer = await broker((packet) => (packet.cmd === 'connect' ? connack : undefined));
  try {
    const client = createTcpClient(peer.options);
    await setTimeout(25);
    expect(peer.opened()).toBe(0);
    const opening = client.connect();
    expect(client.connect()).toBe(opening);
    const connected = await opening;
    expect(peer.opened()).toBe(1);
    expect(peer.commands).toEqual(['connect']);
    const closed = once(peer.events, 'peer-close');
    await connected.disconnect();
    await closed;
    expect(peer.commands).toEqual(['connect', 'disconnect']);
  } finally {
    await peer.close();
  }
});

test('delivers QoS 0 messages with mutable Buffer payloads', async () => {
  const peer = await broker((packet: Readonly<Pick<Packet, 'cmd'>>) => {
    if (packet.cmd === 'connect') return connack;
    if (packet.cmd === 'publish')
      return {
        cmd: 'publish',
        qos: 0,
        dup: false,
        retain: false,
        topic: 'tcp/binary',
        payload: Buffer.from([0, 255, 128]),
      };
    return undefined;
  });
  const received: unknown[] = [];
  try {
    const client = await createTcpClient({
      ...peer.options,
      onMessage(message: Readonly<{ payload: unknown; qos: unknown; cmd: unknown }>) {
        received.push(message);
      },
    }).connect();
    await client.publish('tcp/binary', 'request');
    await vi.waitFor(() => {
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ cmd: 'publish', qos: 0, payload: Buffer.from([0, 255, 128]) });
    });
    const message = received[0];
    if (typeof message !== 'object' || message === null || !('payload' in message) || !Buffer.isBuffer(message.payload))
      throw new Error('Expected a received Buffer');
    message.payload[0] = 42;
    expect(message.payload[0]).toBe(42);
    await client.disconnect();
  } finally {
    await peer.close();
  }
});

test('sends PINGREQ and waits for PINGRESP', async () => {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  const peer = await broker((packet) => (packet.cmd === 'connect' ? connack : undefined));
  try {
    const client = await createTcpClient(peer.options).connect();
    const request = once(peer.events, 'pingreq');
    const ping = client.ping();
    let settled = false;
    void ping.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const requestArguments: unknown[] = await request;
    const [socket] = requestArguments;
    if (!(socket instanceof Socket)) throw new Error('Expected TCP socket');
    expect(settled).toBe(false);
    socket.write(Buffer.from([0xd0, 0]));
    await ping;
    await client.disconnect();
  } finally {
    await peer.close();
  }
});

test('preserves a CONNACK refusal code and closes without DISCONNECT', async () => {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  const peer = await broker((packet) =>
    packet.cmd === 'connect' ? { cmd: 'connack', reasonCode: 0x87, sessionPresent: false } : undefined,
  );
  try {
    const closed = once(peer.events, 'peer-close');
    await expect(createTcpClient(peer.options).connect()).rejects.toMatchObject({ code: 0x87 });
    await closed;
    expect(peer.commands).toEqual(['connect']);
  } finally {
    await peer.close();
  }
});

test('does not open a socket when the signal is already aborted', async () => {
  const peer = await broker(() => undefined);
  try {
    const controller = new AbortController();
    controller.abort();
    await expect(createTcpClient({ ...peer.options, signal: controller.signal }).connect()).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(peer.opened()).toBe(0);
  } finally {
    await peer.close();
  }
});

test('aborts while waiting for CONNACK and removes the signal listener', async () => {
  const peer = await broker(() => undefined);
  try {
    const controller = new AbortController();
    const request = once(peer.events, 'connect');
    const closed = once(peer.events, 'peer-close');
    const connecting = createTcpClient({ ...peer.options, signal: controller.signal }).connect();
    const reason = new Error('caller cancelled the handshake');
    const rejected = (async () => {
      await expect(connecting).rejects.toBe(reason);
    })();
    await request;
    controller.abort(reason);
    await rejected;
    await closed;
    expect(peer.commands).toEqual(['connect']);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  } finally {
    await peer.close();
  }
});

test('disconnects once and rejects an outstanding SUBSCRIBE', async () => {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  const peer = await broker((packet) => (packet.cmd === 'connect' ? connack : undefined));
  try {
    const controller = new AbortController();
    const client = await createTcpClient({ ...peer.options, signal: controller.signal }).connect();
    controller.abort();
    const request = once(peer.events, 'subscribe');
    const subscribed = client.subscribe('tcp/teardown');
    const rejected = (async () => {
      await expect(subscribed).rejects.toThrow('Client disconnected');
    })();
    await request;
    const closed = once(peer.events, 'peer-close');
    const closing = client.disconnect();
    expect(client.disconnect()).toBe(closing);
    await Promise.all([closing, rejected, closed]);
    await expect(client.publish('tcp/teardown', 'late')).rejects.toThrow('closing');
    expect(peer.commands).toEqual(['connect', 'subscribe', 'disconnect']);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
  } finally {
    await peer.close();
  }
});

test('closes the connection after a ping times out so a late reply cannot satisfy another ping', async () => {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  const peer = await broker((packet) => (packet.cmd === 'connect' ? connack : undefined));
  try {
    const client = await createTcpClient({ ...peer.options, timeoutMs: 150 }).connect();
    const closed = once(peer.events, 'peer-close');
    await expect(client.ping()).rejects.toThrow('MQTT operation timed out');
    await closed;
    await expect(client.ping()).rejects.toThrow('MQTT operation timed out');
    expect(peer.commands).toEqual(['connect', 'pingreq']);
  } finally {
    await peer.close();
  }
});

test('closes TCP and rejects pending work when a message callback throws', async () => {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  const peer = await broker((packet) => (packet.cmd === 'connect' ? connack : undefined));
  try {
    const reason = new Error('observer failed');
    const client = await createTcpClient({
      ...peer.options,
      onMessage: () => {
        throw reason;
      },
    }).connect();
    const request = once(peer.events, 'subscribe');
    const pending = client.subscribe('tcp/observer');
    const rejected = (async () => {
      await expect(pending).rejects.toBe(reason);
    })();
    const requestArguments: unknown[] = await request;
    const [socket] = requestArguments;
    if (!(socket instanceof Socket)) throw new Error('Expected TCP socket');
    const closed = once(peer.events, 'peer-close');
    socket.write(
      generate(
        {
          cmd: 'publish',
          topic: 'tcp/observer',
          payload: 'hello',
          qos: 0,
          dup: false,
          retain: false,
        },
        { protocolVersion: 5 },
      ),
    );
    await Promise.all([rejected, closed]);
    await expect(client.ping()).rejects.toBe(reason);
  } finally {
    await peer.close();
  }
});
