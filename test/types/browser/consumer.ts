import { createBrowserClient, createReconnectingClient, createSessionState } from 'mqtt/browser';
import type { BrowserClientOptions, BrowserSession, ClientFactory, ClientSession } from 'mqtt/browser';

const namedOptions: BrowserClientOptions = {
  url: 'wss://localhost/mqtt',
  clientId: 'named-browser-types',
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `message` is typed `BrowserMessage`, and `Readonly<BrowserMessage>` still fails the rule, so the accepted type would be a hand-written list of the members used here, which has to change with every new use of `message`. The deep read-only type in `src/util/bytes.ts` is not part of the published package, which is all this file imports. `BrowserMessage` is declared in `src/browserClient.ts`.
  onMessage(message) {
    const bytes: Uint8Array = message.payload;
    const qualityOfService: 0 = message.qos;
    bytes[0] = qualityOfService;
  },
};
export const browserFactory: ClientFactory = createBrowserClient(namedOptions);
type RequireTrue<Value extends true> = Value;
export type BrowserSessionIsCommon = RequireTrue<BrowserSession extends ClientSession ? true : false>;

export async function checkBrowserTypes(signal: Readonly<AbortSignal>) {
  const client = await createBrowserClient({
    url: new URL('wss://localhost/mqtt'),
    clientId: 'browser-types',
    signal,
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Removing it would cost developer experience. `message` is typed `BrowserMessage`, and `Readonly<BrowserMessage>` still fails the rule, so the accepted type would be a hand-written list of the members used here, which has to change with every new use of `message`. The deep read-only type in `src/util/bytes.ts` is not part of the published package, which is all this file imports. `BrowserMessage` is declared in `src/browserClient.ts`.
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

export const reconnectingBrowser = createReconnectingClient(
  createBrowserClient,
  { url: 'wss://localhost/mqtt', clientId: 'reconnecting' },
  { subscriptions: [{ topic: 'alerts' }] },
);

export const resumingBrowser = createReconnectingClient(
  createBrowserClient,
  { url: 'wss://localhost/mqtt', clientId: 'resuming', sessionExpiryInterval: 600 },
  { resume: true },
);
export const resumedBrowser = createBrowserClient({
  url: 'wss://localhost/mqtt',
  clientId: 'resumed',
  cleanStart: false,
  sessionExpiryInterval: 600,
  sessionState: createSessionState(),
});

export * from '../../packed/browser/consumer.js';
