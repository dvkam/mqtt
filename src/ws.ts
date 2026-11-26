// The Node WebSocket client. It needs the optional peer dependency `ws`, so it has its own entry: importing `mqtt` alone
// never loads `ws`.
export { createWebSocketClient } from './websocketClient.js';
export type { WebSocketClientOptions } from './websocketClient.js';
export type { WillOptions } from './will.js';
export type { ConnectionInfo, SubscribeResult, UnsubscribeResult } from './session.js';
