import { createBrowserClient } from 'mqtt/browser';

export async function probeReceive(url: string) {
  const accepted = [];
  for (const mode of ['exact', 'ws-fragments', 'mqtt-split', 'coalesced']) {
    const messages: string[] = [];
    const client = await createBrowserClient({
      url: url + '/?mode=' + mode,
      clientId: mode,
      timeoutMs: 1000,
      maxPacketBytes: 8,
      maxWebSocketMessageBytes: mode === 'mqtt-split' ? 4 : mode === 'coalesced' ? 16 : 8,
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The packed callback verifies the native mutable publication contract.
      onMessage(message) {
        messages.push(new TextDecoder().decode(message.payload));
      },
    }).connect();
    try {
      await client.publish('a', 'test');
      await client.ping();
      accepted.push({ mode, messages });
    } finally {
      await client.disconnect();
    }
  }
  const rejected = [];
  for (const mode of ['oversized-connect', 'suback-overflow', 'ping-overflow', 'partial-overflow', 'ws-fragments-overflow']) {
    let delivered = 0;
    const opening = createBrowserClient({
      url: url + '/?mode=' + mode,
      clientId: mode,
      timeoutMs: 1000,
      maxPacketBytes: 8,
      maxWebSocketMessageBytes: 8,
      onMessage() {
        delivered++;
      },
    }).connect();
    let failure: unknown;
    let sameFailure = true;
    if (mode === 'oversized-connect') failure = await opening.catch((reason: unknown) => reason);
    else {
      const client = await opening;
      try {
        failure = await (mode === 'suback-overflow' ? client.subscribe('a') : client.ping()).catch((reason: unknown) => reason);
        const later = await client.publish('a', 'late').catch((reason: unknown) => reason);
        sameFailure = failure === later;
      } finally {
        await client.disconnect().catch(() => {});
      }
    }
    rejected.push({
      mode,
      rangeError: failure instanceof RangeError,
      message: failure instanceof Error ? failure.message : null,
      sameFailure,
      delivered,
    });
  }
  return { accepted, rejected };
}
