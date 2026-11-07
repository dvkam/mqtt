import WebSocket, { createWebSocketStream } from 'ws';
import type { WebSocketOptions } from './interfaces/webSocketOptions.js';
import type { WebSocketStream } from './interfaces/webSocketStream.js';

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The factory passes native stream options through to the WebSocket adapter.
export function buildWebSocketStream(opts: Readonly<WebSocketOptions>): WebSocketStream {
  const socket = new WebSocket(opts.url, [opts.websocketSubProtocol]);
  const webSocketStream: WebSocketStream = createWebSocketStream(socket, opts.wsOptions);
  webSocketStream.url = opts.url;
  socket.on('close', () => {
    webSocketStream.destroy();
  });
  return webSocketStream;
}
