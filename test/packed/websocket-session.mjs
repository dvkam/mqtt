import { openBrowserTransport } from 'mqtt/browser';
import { encodePacket, PacketDecoder } from 'mqtt/codec';

export async function mqttSession(url, packets) {
  const decoder = new PacketDecoder();
  const received = [];
  let wake;
  let failure;
  function fail() {
    failure ??= new Error('WebSocket ended during MQTT exchange');
    wake?.();
  }
  function receive(bytes) {
    for (const packet of decoder.push(bytes)) received.push(Array.from(encodePacket(packet)));
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
  const input = new PacketDecoder();
  const requests = packets.map((bytes) => encodePacket(input.push(Uint8Array.from(bytes))[0]));
  try {
    const replies = [];
    for (const request of requests.slice(0, -1)) {
      transport.send(request);
      replies.push(await nextPacket());
    }
    transport.send(requests.at(-1));
    await transport.close();
    return replies;
  } finally {
    await transport.close();
  }
}
