import { openMqttWebSocket } from 'mqtt/websocket';

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
