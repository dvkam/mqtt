interface WebSocketOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Open a binary MQTT WebSocket. The returned socket retains native send and close semantics. */
export async function openMqttWebSocket(
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native WebSocket accepts caller-owned URL and AbortSignal objects.
  url: Readonly<string | URL>,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native WebSocket accepts caller-owned URL and AbortSignal objects.
  { signal, timeoutMs = 3000 }: Readonly<WebSocketOptions> = {},
) {
  if (signal?.aborted === true) throw signal.reason;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError('MQTT WebSocket timeout must be positive and fit in a timer');
  }
  if (typeof WebSocket === 'undefined') throw new Error('MQTT WebSocket requires a native WebSocket implementation');

  const socket = new WebSocket(url, 'mqtt');
  socket.binaryType = 'arraybuffer';
  return new Promise<WebSocket>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      socket.removeEventListener('open', opened);
      socket.removeEventListener('close', failed);
      socket.removeEventListener('error', failed);
    };
    const fail = (reason: unknown) => {
      cleanup();
      if (socket.readyState < WebSocket.CLOSING) socket.close();
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve AbortSignal.reason, including native non-Error reasons.
      reject(reason);
    };
    const failed = () => {
      fail(new Error('MQTT WebSocket handshake failed'));
    };
    const aborted = () => {
      fail(signal?.reason);
    };
    const opened = () => {
      if (socket.protocol !== 'mqtt') {
        fail(new Error('MQTT WebSocket subprotocol was not negotiated'));
        return;
      }
      cleanup();
      resolve(socket);
    };
    const timer = setTimeout(() => {
      fail(new Error('MQTT WebSocket handshake timed out'));
    }, timeoutMs);
    socket.addEventListener('open', opened);
    socket.addEventListener('close', failed);
    socket.addEventListener('error', failed);
    signal?.addEventListener('abort', aborted, { once: true });
  });
}
