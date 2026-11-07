import { openBrowserTransport, createBrowserClient } from 'mqtt/browser';
import { encodePacket, PacketDecoder } from 'mqtt/codec';

/** @param {string} url */
export async function mqttClientSession(url) {
  /** @type {((message: {readonly topic: string, readonly payload: readonly number[]}) => void) | undefined} */
  let receive;
  let timer;
  const client = await createBrowserClient({
    url,
    clientId: 'browser-client-ci',
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    onMessage(packet) {
      receive?.({ topic: packet.topic, payload: Array.from(packet.payload) });
    },
  }).connect();
  try {
    await client.subscribe('ci/browser-client');
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
    await client.ping();
    await client.disconnect();
    return message;
  } finally {
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
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
  function receive(bytes) {
    for (const packet of decoder.push(bytes)) received.push(Array.from(encodePacket(packet)));
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

  const transport = await openBrowserTransport(url, { onBytes: receive, onClose: fail });
  const input = new PacketDecoder();
  const requests = packets.map((/** @type {readonly number[]} */ bytes) => {
    const packet = input.push(Uint8Array.from(bytes))[0];
    if (packet === undefined) throw new Error('Missing request packet');
    return encodePacket(packet);
  });
  try {
    const replies = [];
    for (const request of requests.slice(0, -1)) {
      transport.send(request);
      replies.push(await nextPacket());
    }
    const last = requests[requests.length - 1];
    if (last === undefined) throw new Error('Missing DISCONNECT request');
    transport.send(last);
    await transport.close();
    return replies;
  } finally {
    await transport.close();
  }
}
