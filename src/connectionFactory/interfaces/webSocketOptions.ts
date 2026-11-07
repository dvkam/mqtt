import type { URL } from 'url';
import type { DuplexOptions } from 'node:stream';

export interface WebSocketOptions {
  protocolVersion?: number;
  browserBufferTimeout?: number;
  browserBufferSize?: number;
  objectMode?: any;
  url: URL;
  hostname: string;
  protocol: string;
  protocolId?: string;
  websocketSubProtocol: 'mqttv3.1' | 'mqtt';
  port: number;
  path: string;
  binary?: boolean;
  wsOptions: DuplexOptions;
}
