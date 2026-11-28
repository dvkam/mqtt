import { createBrowserClient } from 'mqtt/browser';
import { openNativeWebSocket } from './native-websocket.mjs';
import { encodePacket, PacketDecoder } from 'mqtt/codec';
import { checkWills } from './will-scenario.mjs';

/** @param {string} url */
export async function mqttWillNotifications(url) {
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `options` is typed `WillClientOptions`, which this file cannot write in a read-only form by name, so the accepted type would be a hand-written copy of it. The deep read-only type in `src/util/bytes.ts` is not part of the published package, which is all this file imports.
  return checkWills((options) => createBrowserClient({ ...options, url }));
}

/** @param {string} url */
export async function mqttClientSession(url) {
  /** @type {((message: {readonly topic: string, readonly payload: readonly number[]}) => void) | undefined} */
  let receive;
  let timer;
  /** @type {string[]} */
  const inbound = [];
  let releaseInbound = () => {};
  let arrivedFirst = () => {};
  let arrivedSecond = () => {};
  const held = new Promise((resolve) => {
    releaseInbound = () => {
      resolve(undefined);
    };
  });
  const first = new Promise((resolve) => {
    arrivedFirst = () => {
      resolve(undefined);
    };
  });
  const second = new Promise((resolve) => {
    arrivedSecond = () => {
      resolve(undefined);
    };
  });
  const client = await createBrowserClient({
    url,
    clientId: 'browser-client-ci',
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `packet` is typed `BrowserMessage`, which this file cannot write in a read-only form by name, so the accepted type would be a hand-written copy of it. The deep read-only type in `src/util/bytes.ts` is not part of the published package, which is all this file imports. `BrowserMessage` is declared in `src/browserClient.ts`.
    onMessage(packet) {
      receive?.({ topic: packet.topic, payload: Array.from(packet.payload) });
    },
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `packet` is typed `BrowserQosOneMessage`, which this file cannot write in a read-only form by name, so the accepted type would be a hand-written copy of it. The deep read-only type in `src/util/bytes.ts` is not part of the published package, which is all this file imports. `BrowserQosOneMessage` is declared in `src/browserClient.ts`.
    async onQosOneMessage(packet) {
      if (!(packet.payload instanceof Uint8Array) || packet.messageId <= 0) throw new Error('Unexpected browser QoS 1 message');
      inbound.push(new TextDecoder().decode(packet.payload));
      if (inbound.length === 1) {
        arrivedFirst();
        await held;
      } else arrivedSecond();
    },
  }).connect();
  try {
    await Promise.all([client.subscribe('ci/browser-client'), client.subscribe('ci/browser-other'), client.ping()]);
    await client.subscribe('ci/qos1', { qos: 1 });
    await Promise.all([client.publish('ci/qos1', 'first', { qos: 1 }), client.publish('ci/qos1', 'second', { qos: 1 }), first]);
    await client.ping();
    if (inbound.join(',') !== 'first') throw new Error('Browser broker sent a second QoS 1 message before PUBACK');
    releaseInbound();
    await second;
    if (inbound.join(',') !== 'first,second') throw new Error('Unexpected browser QoS 1 delivery order');
    const reply = new Promise(
      /** @param {(message: {readonly topic: string, readonly payload: readonly number[]}) => void} resolve */ (
        resolve,
        reject,
      ) => {
        receive = resolve;
        timer = setTimeout(() => {
          reject(new Error('Browser client echo timed out'));
        }, 3000);
      },
    );
    const [, message] = await Promise.all([client.publish('ci/browser-client', 'hello'), reply]);
    await client.unsubscribe('ci/browser-client');
    await client.ping();
    await client.disconnect();
    return message;
  } finally {
    releaseInbound();
    clearTimeout(timer);
    await client.disconnect();
  }
}

/** @param {string} url @param {readonly (readonly number[])[]} packets */
export async function mqttSession(url, packets) {
  const decoder = new PacketDecoder();
  /** @type {number[][]} */
  const received = [];
  /** @type {(() => void) | undefined} */
  let wake;
  /** @type {Error | undefined} */
  let failure;
  function fail() {
    failure ??= new Error('WebSocket ended during MQTT exchange');
    wake?.();
  }
  /** @param {Uint8Array} bytes */
  function receive(/** @type {Readonly<Uint8Array<Readonly<ArrayBufferLike>>>} */ bytes) {
    try {
      for (const packet of decoder.push(bytes)) received.push(Array.from(encodePacket(packet)));
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error('MQTT reply could not be decoded');
    }
    wake?.();
  }

  async function nextPacket() {
    const deadline = setTimeout(fail, 3000);
    try {
      while (received.length === 0 && failure === undefined)
        await new Promise((resolve) => {
          wake = () => {
            resolve(undefined);
          };
        });
      if (failure !== undefined) throw failure;
      const packet = received.shift();
      if (packet === undefined) throw new Error('Missing decoded packet');
      return packet;
    } finally {
      clearTimeout(deadline);
      wake = undefined;
    }
  }

  const socket = await openNativeWebSocket(url);
  const closed = new Promise((resolve) => {
    socket.addEventListener('close', resolve, { once: true });
  });
  socket.addEventListener('close', fail);
  socket.addEventListener('error', fail);
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `event` is typed `MessageEvent<any>`, and `Readonly<MessageEvent<any>>` still fails the rule, so the accepted type would be a hand-written list of the members used here, which has to change with every new use of `event`. The deep read-only type in `src/util/bytes.ts` is not part of the published package, which is all this file imports. `MessageEvent` is declared in `the DOM library`.
  socket.addEventListener('message', (/** @type {MessageEvent} */ event) => {
    if (event.data instanceof ArrayBuffer) receive(new Uint8Array(event.data));
    else fail();
  });
  const input = new PacketDecoder();
  const requests = packets.map((/** @type {readonly number[]} */ bytes) => {
    const packet = input.push(Uint8Array.from(bytes))[0];
    if (packet === undefined) throw new Error('Missing request packet');
    return encodePacket(packet);
  });
  try {
    const replies = [];
    for (const request of requests.slice(0, -1)) {
      socket.send(request);
      replies.push(await nextPacket());
    }
    const last = requests[requests.length - 1];
    if (last === undefined) throw new Error('Missing DISCONNECT request');
    socket.send(last);
    return replies;
  } finally {
    socket.close();
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let closeTimer;
    await Promise.race([
      closed,
      new Promise((_resolve, reject) => {
        closeTimer = setTimeout(() => {
          reject(new Error('WebSocket did not close within 3 s'));
        }, 3000);
      }),
    ]).finally(() => {
      clearTimeout(closeTimer);
    });
  }
}
