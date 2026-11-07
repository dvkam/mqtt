import { openBrowserTransport } from 'mqtt/browser';

export async function mqttSession(url, packets) {
  let buffer = new Uint8Array();
  const received = [];
  let wake;
  let failure;
  function fail() {
    failure ??= new Error('WebSocket ended during MQTT exchange');
    wake?.();
  }
  function receive(bytes) {
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
  }

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

  const transport = await openBrowserTransport(url, { onBytes: receive, onClose: fail });
  try {
    const replies = [];
    for (const request of packets.slice(0, -1)) {
      transport.send(Uint8Array.from(request));
      replies.push(await nextPacket());
    }
    transport.send(Uint8Array.from(packets.at(-1)));
    await transport.close();
    return replies;
  } finally {
    await transport.close();
  }
}
