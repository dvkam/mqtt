// Compiles the useDuplex adapter from docs/recipes/using-custom-transports.md against the built declarations and checks the
// public transport contract. The recipe shows the same code without the lint suppressions.
import type { Duplex } from 'node:stream';
import {
  createTransportClient,
  type ByteInbound,
  type ByteTransport,
  type ByteWriter,
  type ClientFactory,
  type OpenContext,
} from '../../dist/index.js';
import { createTransportClient as createPortableTransportClient } from '../../dist/portableClient.js';

type RequireTrue<Value extends true> = Value;
type Same<Left, Right> =
  (<Value>(_value: Value) => Value extends Left ? 1 : 2) extends <Value>(_value: Value) => Value extends Right ? 1 : 2
    ? true
    : false;

declare function openMyTunnel(): Promise<Duplex>;

// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- A Node Duplex has mutable stream state, and the adapter calls write, end and destroy on it.
function useDuplex(stream: Duplex): ByteTransport {
  return {
    name: 'Duplex',
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ByteTransport.open in src/byteTransport.ts declares this ByteInbound and OpenContext, and OpenContext holds a native AbortSignal.
    async open(inbound, { timeoutMs }) {
      stream.on('data', inbound.bytes).on('end', inbound.end).on('error', inbound.fail);
      const closed = new Promise<void>((resolve) => {
        stream.once('close', () => {
          inbound.end();
          resolve();
        });
      });
      return Promise.resolve({
        get bufferedBytes() {
          return stream.writableLength;
        },
        // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- ByteWriter.write in src/byteTransport.ts declares a Uint8Array chunk, which has a mutable index signature.
        async write(bytes) {
          return new Promise<void>((resolve, reject) => {
            // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Writable.write in @types/node passes its callback a mutable Error.
            stream.write(bytes, (error) => {
              if (error) reject(error);
              else resolve();
            });
          });
        },
        async close(force) {
          const timer = setTimeout(() => {
            stream.destroy();
          }, timeoutMs);
          try {
            if (force) stream.destroy();
            else stream.end();
            await closed;
          } finally {
            clearTimeout(timer);
          }
        },
      });
    },
  };
}

export async function publishOverTunnel(): Promise<void> {
  const socket: Duplex = await openMyTunnel();
  const session = await createTransportClient(useDuplex(socket), { clientId: 'sensor-7' }).connect();
  try {
    await session.publish('sensor/reading', '24.1');
  } finally {
    await session.disconnect();
  }
}

type OpenParameters = Parameters<ByteTransport['open']>;
export type OpenReceivesInbound = RequireTrue<Same<OpenParameters[0], ByteInbound>>;
export type OpenReceivesContext = RequireTrue<Same<OpenParameters[1], OpenContext>>;
export type OpenReturnsWriter = RequireTrue<Same<ReturnType<ByteTransport['open']>, Promise<ByteWriter>>>;
// `this: void` lets an adapter pass inbound.bytes, inbound.end and inbound.fail as listeners without binding them.
export type InboundMethodsNeedNoReceiver = RequireTrue<
  Same<
    [ThisParameterType<ByteInbound['bytes']>, ThisParameterType<ByteInbound['end']>, ThisParameterType<ByteInbound['fail']>],
    [void, void, void]
  >
>;
export type BothEntriesReturnAFactory = RequireTrue<
  Same<ReturnType<typeof createTransportClient>, ClientFactory> extends true
    ? Same<ReturnType<typeof createPortableTransportClient>, ClientFactory>
    : false
>;

const writer = { bufferedBytes: 0, write: async () => Promise.resolve(), close: async () => Promise.resolve() };

// @ts-expect-error A transport needs a name for the core's own error messages.
export const missingName: ByteTransport = {
  open: async () => Promise.resolve(writer),
};

export const missingWrite: ByteTransport = {
  name: 'no write',
  // @ts-expect-error The writer must implement write.
  open: async () => Promise.resolve({ bufferedBytes: 0, close: async () => Promise.resolve() }),
};

export const textWriter: ByteTransport = {
  name: 'text',
  // @ts-expect-error write receives bytes, not text.
  open: async () => Promise.resolve({ ...writer, write: async (chunk: string) => Promise.resolve(void chunk) }),
};
