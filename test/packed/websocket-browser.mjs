import { openMqttWebSocket } from 'mqtt/websocket';
import { openBrowserTransport } from 'mqtt/browser';

export async function exchangeTransport(url) {
  let receive;
  let reject;
  const reply = new Promise((resolve, fail) => {
    receive = resolve;
    reject = fail;
  });
  const transport = await openBrowserTransport(url, {
    onBytes(bytes) {
      receive(Array.from(bytes));
    },
    onClose(reason) {
      reject(reason);
    },
  });
  const timer = setTimeout(() => reject(new Error('MQTT frame did not arrive')), 3000);
  try {
    transport.send(Uint8Array.of(0xc0, 0));
    return await reply;
  } finally {
    clearTimeout(timer);
    await transport.close();
  }
}

export async function exchange(url) {
  const socket = await openMqttWebSocket(url);
  const listeners = new AbortController();
  let timer;
  try {
    const result = new Promise((resolve, reject) => {
      const fail = () => reject(new Error('WebSocket closed or failed during exchange'));
      const options = { once: true, signal: listeners.signal };
      socket.addEventListener('message', (event) => resolve(Array.from(new Uint8Array(event.data))), options);
      socket.addEventListener('error', fail, options);
      socket.addEventListener('close', fail, options);
      timer = setTimeout(() => reject(new Error('WebSocket frame did not arrive')), 3000);
    });
    socket.send(Uint8Array.of(0xc0, 0));
    return { protocol: socket.protocol, bytes: await result };
  } finally {
    clearTimeout(timer);
    listeners.abort();
    socket.close();
  }
}

export async function measureQueue(url, open = openMqttWebSocket) {
  const socket = await open(url);
  const budget = 128 * 1024;
  const bytes = new Uint8Array(64 * 1024);
  const closed = new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }));
  let admitted = 0;
  let peak = 0;
  let timer;
  try {
    while (admitted < 512 && socket.bufferedAmount + bytes.byteLength <= budget) {
      socket.send(bytes);
      admitted++;
      peak = Math.max(peak, socket.bufferedAmount);
    }
    const nextWouldExceed = socket.bufferedAmount + bytes.byteLength > budget;
    const beforeClose = performance.now();
    await Promise.race([
      closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Stalled peer did not close')), 3000);
      }),
    ]);
    return { admitted, peak, budget, nextWouldExceed, closeMs: performance.now() - beforeClose };
  } finally {
    clearTimeout(timer);
    socket.close();
  }
}
