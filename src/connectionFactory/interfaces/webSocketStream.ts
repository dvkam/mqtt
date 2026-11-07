import type { Duplex } from 'stream';
import type { WebSocketOptions } from './webSocketOptions.js';
import type { URL } from 'url';

export interface WebSocketStream extends Duplex {
  setReadable?: any;
  setWritable?: any;
  socket?: WebSocket;
  opts?: WebSocketOptions;
  websocketSubProtocol?: any;
  url?: URL;
}
