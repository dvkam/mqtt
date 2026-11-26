/** @typedef {Pick<Readonly<import('mqtt/browser').BrowserClientOptions>, 'clientId' | 'signal' | 'will' | 'onMessage'>} WillClientOptions */

export async function checkWills(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The factory uses a native AbortSignal and mutable byte options.
  /** @type {(options: WillClientOptions) => import('mqtt').ClientFactory} */ create,
) {
  const decoded = new TextDecoder();
  /** @type {{topic: string, payload: string}[]} */
  const messages = [];
  /** @type {(() => void) | undefined} */
  let arrived;
  const observer = await create({
    clientId: 'packed-will-observer',
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The callback receives the original mutable payload view.
    onMessage(packet) {
      messages.push({ topic: packet.topic, payload: decoded.decode(packet.payload) });
      arrived?.();
    },
  }).connect();
  try {
    for (const mode of /** @type {const} */ (['graceful', 'abrupt', 'with-will'])) {
      const topic = 'ci/will/' + mode;
      await observer.subscribe(topic);
      const start = messages.length;
      const signal = new AbortController();
      const device = await create({
        clientId: 'packed-will-device',
        signal: signal.signal,
        will: {
          topic,
          payload: 'offline',
          qos: mode === 'with-will' ? 2 : 1,
          payloadFormatIndicator: 1,
          contentType: 'text/plain',
        },
      }).connect();
      /** @type {ReturnType<typeof setTimeout> | undefined} */
      let timer;
      try {
        /** @type {(received: boolean) => void} */
        let settle = () => {};
        /** @type {Promise<boolean>} */
        const expected = new Promise((resolve) => {
          settle = resolve;
        });
        arrived = () => {
          settle(true);
        };
        if (mode === 'abrupt') {
          const stopped = new Error('break the device connection');
          signal.abort(stopped);
          const result = await device.disconnect().catch((/** @type {unknown} */ error) => error);
          if (result !== stopped) throw new Error('Device did not retain the abort reason');
        } else {
          await device.disconnect(mode === 'with-will' ? { reasonCode: 4 } : undefined);
          if (mode === 'graceful') {
            // If the first connection leaked, taking over its identifier makes the broker publish its Will.
            await (await create({ clientId: 'packed-will-device' }).connect()).disconnect();
          }
        }
        timer = setTimeout(
          () => {
            settle(false);
          },
          mode === 'graceful' ? 200 : 3000,
        );
        const received = await expected;
        if (received !== (mode !== 'graceful')) throw new Error('Unexpected Will delivery for ' + mode);
        const message = messages[start];
        if (received && (message?.topic !== topic || message.payload !== 'offline' || messages.length !== start + 1))
          throw new Error('Wrong Will notification');
      } finally {
        clearTimeout(timer);
        arrived = undefined;
        if (!signal.signal.aborted) await device.disconnect();
      }
      await observer.unsubscribe(topic);
    }
    return messages.map((/** @type {Readonly<{ topic: string }>} */ { topic }) => topic);
  } finally {
    await observer.disconnect();
  }
}
