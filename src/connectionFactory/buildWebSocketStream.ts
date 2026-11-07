import WebSocket, { createWebSocketStream } from 'ws';
import type { WebSocketOptions } from './interfaces/webSocketOptions.js';
import type { WebSocketStream } from './interfaces/webSocketStream.js';

export function buildWebSocketStream(opts: WebSocketOptions): WebSocketStream {
  const socket = new WebSocket(opts.url, [opts.websocketSubProtocol]);
  const webSocketStream: WebSocketStream = createWebSocketStream(socket, opts.wsOptions);
  webSocketStream.url = opts.url;
  socket.on('close', () => {
    webSocketStream.destroy();
  });
  return webSocketStream;
}
