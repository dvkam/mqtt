import { createBrowserClient } from 'mqtt/browser';
import type { BrowserClientOptions, BrowserSession, ClientFactory, ClientSession } from 'mqtt/browser';

const namedOptions: BrowserClientOptions = {
  url: 'wss://localhost/mqtt',
  clientId: 'named-browser-types',
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The callback contract preserves the original mutable Uint8Array.
  onMessage(message) {
    const bytes: Uint8Array = message.payload;
    const qualityOfService: 0 = message.qos;
    bytes[0] = qualityOfService;
  },
};
export const browserFactory: ClientFactory = createBrowserClient(namedOptions);
type RequireTrue<Value extends true> = Value;
export type BrowserSessionIsCommon = RequireTrue<BrowserSession extends ClientSession ? true : false>;

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
export async function checkBrowserTypes(signal: AbortSignal) {
  const client = await createBrowserClient({
    url: new URL('wss://localhost/mqtt'),
    clientId: 'browser-types',
    signal,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The fixture exercises native mutable objects and packet buffers with their declared API types.
    onMessage(message) {
      const payload: Uint8Array = message.payload;
      payload.byteLength.toFixed();
    },
  }).connect();
  await client.subscribe('a');
  await client.publish('a', 'hello');
  await client.ping();
  await client.disconnect();
}

type RequireFalse<Value extends false> = Value;
type Password = NonNullable<BrowserClientOptions['password']>;
export type PasswordAcceptsText = RequireTrue<string extends Password ? true : false>;
export type PasswordAcceptsBytes = RequireTrue<Uint8Array extends Password ? true : false>;
export type PasswordRejectsNumbers = RequireFalse<number extends Password ? true : false>;

export const textPassword = createBrowserClient({
  url: 'wss://localhost/mqtt',
  clientId: 'text-password',
  username: 'u',
  password: 'secret',
});
export const bytePassword = createBrowserClient({
  url: 'wss://localhost/mqtt',
  clientId: 'byte-password',
  password: Uint8Array.of(1, 2),
});

export async function publishBrowserBytes(session: Readonly<BrowserSession>): Promise<void> {
  await session.publish('bytes', Uint8Array.of(1, 2), {
    qos: 1,
    retain: true,
    payloadFormatIndicator: 0,
    messageExpiryInterval: 60,
    contentType: 'application/octet-stream',
    responseTopic: 'reply',
    correlationData: Uint8Array.of(9),
    userProperties: [['k', 'v']],
    signal: AbortSignal.timeout(1000),
  });
}

export * from '../../packed/browser/consumer.js';
