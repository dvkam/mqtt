import type { Server } from 'http';
import type { Server as HttpsServer } from 'https';

export type WsOptions = {
  backlog: number;
  clientTracking: boolean;
  handleProtocols: () => unknown;
  host: string;
  maxPayload: number;
  noServer: boolean;
  path: string;
  perMessageDeflate: boolean | { [optionName: string]: unknown };
  port: number;
  server: Server | HttpsServer;
  skipUTF8Validation: boolean;
  verifyClient: () => unknown;
} & {
  [propertyName: string]: string;
};
