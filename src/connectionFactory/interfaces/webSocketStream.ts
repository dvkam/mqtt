import type { Duplex } from 'stream';
import type { URL } from 'url';

export interface WebSocketStream extends Duplex {
  url?: URL;
}
