import { openMqttWebSocket } from 'mqtt/websocket';

export async function mqttSession(url, packets) {
  const socket = await openMqttWebSocket(url);
  let buffer = new Uint8Array();
  const received = [];
  let wake;
  let failure;
  const listeners = new AbortController();
  const options = { signal: listeners.signal };
  const closed = new Promise((resolve) => socket.addEventListener('close', resolve, { once: true }));
  function fail() {
    failure ??= new Error('WebSocket ended during MQTT exchange');
    wake?.();
  }
  socket.addEventListener('error', fail, options);
  socket.addEventListener('close', fail, options);
  socket.addEventListener(
    'message',
    (event) => {
      const bytes = new Uint8Array(event.data);
      const combined = new Uint8Array(buffer.length + bytes.length);
      combined.set(buffer);
      combined.set(bytes, buffer.length);
      buffer = combined;
      while (buffer.length >= 2) {
        let size = 0;
        let offset = 1;
        while (offset < buffer.length && offset <= 4) {
          const byte = buffer[offset++];
          size += (byte & 127) * 128 ** (offset - 2);
          if (!(byte & 128)) break;
        }
        if (buffer[offset - 1] & 128 || buffer.length < offset + size) break;
        received.push(Array.from(buffer.subarray(0, offset + size)));
        buffer = buffer.subarray(offset + size);
      }
      wake?.();
    },
    options,
  );

  async function nextPacket() {
    const deadline = setTimeout(fail, 3000);
    try {
      while (received.length === 0 && !failure)
        await new Promise((resolve) => {
          wake = resolve;
        });
      if (failure) throw failure;
      return received.shift();
    } finally {
      clearTimeout(deadline);
      wake = undefined;
    }
  }

  try {
    const replies = [];
    for (const request of packets.slice(0, -1)) {
      socket.send(Uint8Array.from(request));
      replies.push(await nextPacket());
    }
    socket.send(Uint8Array.from(packets.at(-1)));
    socket.close();
    let timer;
    try {
      await Promise.race([
        closed,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('WebSocket close timed out')), 3000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    return replies;
  } finally {
    listeners.abort();
    socket.close();
  }
}
