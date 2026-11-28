import { resolveTimeout } from './timeout.js';
import type { WebSocketOptions } from './websocketOptions.js';
import { MqttError } from './mqttError.js';
import type { ReadonlyDeep } from './util/bytes.js';

/** How the opening ended. Every value but the first two completes the message of the error that is thrown. */
type Opening = 'open' | 'aborted' | 'handshake failed' | 'subprotocol was not negotiated' | 'handshake timed out';

/** Open a binary MQTT WebSocket. The returned socket retains native send and close semantics. */
export async function openMqttWebSocket(
  url: string | ReadonlyDeep<URL>,
  { signal, timeoutMs = 3000 }: ReadonlyDeep<WebSocketOptions> = {},
) {
  if (signal?.aborted === true) throw signal.reason;
  resolveTimeout(timeoutMs);
  if (typeof WebSocket === 'undefined')
    throw new MqttError('ERR_MQTT_TRANSPORT', 'MQTT WebSocket requires a native WebSocket implementation');

  const socket = new WebSocket(url, 'mqtt');
  socket.binaryType = 'arraybuffer';
  const outcome = await new Promise<Opening>((resolve) => {
    const settle = (result: Opening) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      socket.removeEventListener('open', opened);
      socket.removeEventListener('close', failed);
      socket.removeEventListener('error', failed);
      if (result !== 'open' && socket.readyState < WebSocket.CLOSING) socket.close();
      resolve(result);
    };
    const failed = () => {
      settle('handshake failed');
    };
    const aborted = () => {
      settle('aborted');
    };
    const opened = () => {
      settle(socket.protocol === 'mqtt' ? 'open' : 'subprotocol was not negotiated');
    };
    const timer = setTimeout(() => {
      settle('handshake timed out');
    }, timeoutMs);
    socket.addEventListener('open', opened);
    socket.addEventListener('close', failed);
    socket.addEventListener('error', failed);
    signal?.addEventListener('abort', aborted, { once: true });
  });
  if (outcome === 'open') return socket;
  // The caller's own abort reason passes through unchanged, whatever its type.
  if (outcome === 'aborted') throw signal?.reason;
  throw new MqttError(outcome === 'handshake timed out' ? 'ERR_MQTT_TIMEOUT' : 'ERR_MQTT_TRANSPORT', 'MQTT WebSocket ' + outcome);
}
