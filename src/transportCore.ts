import { encodePacket } from './codec.js';
import type { ByteInbound, ByteTransport, ByteWriter } from './byteTransport.js';
import type { BytePlatform } from './bytePlatform.js';
import { PacketInput } from './packetInput.js';
import {
  allowsNativeWrite,
  recordNativeBudgetFailure,
  resolveNativeWriteLimits,
  type NativeWriteLimits,
} from './nativeWriteBudget.js';
import { connectPortable, type PacketTransport, type PortableOptions } from './portable.js';
import { resolvePublicationLimits } from './publicationAdmission.js';
import type { ClientFactory, ClientSession } from './session.js';
import { resolveSubscriptionLimits } from './subscriptionExchanges.js';
import { resolveTimeout } from './timeout.js';
import { invalidOption, MqttError, transportFailure } from './mqttError.js';
import { capturePassword } from './password.js';
import { captureWill, type WillMessage, type WillOptions } from './will.js';
import { sessionBinding, type SessionBinding, type SessionState } from './sessionState.js';

export const flushNativeWrites = Symbol('flushNativeWrites');
export type ByteWriterWithFlush = ByteWriter & { [flushNativeWrites]?(): void };

export interface ByteClientOptions<Bytes extends Uint8Array = Uint8Array>
  extends
    Omit<PortableOptions<Bytes>, 'will' | 'password' | 'cleanStart' | 'sessionExpiryInterval' | 'session'>,
    SessionOptions,
    NativeWriteLimits {
  /** The CONNECT password, at most 65,535 bytes. A string is sent as its UTF-8 bytes. */
  password?: string | Uint8Array;
  signal?: AbortSignal;
  maxPacketBytes?: number;
  will?: WillOptions;
}

/** The CONNECT fields and the client state that decide which MQTT session a connection opens or resumes. */
export interface SessionOptions {
  /**
   * The CONNECT Clean Start flag. True asks the broker to discard any session it keeps for the client identifier and start
   * a new one. False asks it to resume that session, and the CONNACK Session Present flag in `connection.sessionPresent`
   * says whether it did. Defaults to true.
   */
  cleanStart?: boolean;
  /**
   * The CONNECT Session Expiry Interval: how many seconds the broker keeps the session after the connection closes. An
   * integer from 0 to 4,294,967,295, where 4,294,967,295 means the session does not expire. When it is absent the client
   * sends none, and the broker ends the session with the connection. The broker can lower it in CONNACK, and
   * `connection.sessionExpiryInterval` holds the value in effect.
   */
  sessionExpiryInterval?: number;
  /**
   * The QoS 1 publications that a connection wrote and the broker did not acknowledge, kept for the next connection of
   * the same session. Pass the object `createSessionState()` returns. A connection with Clean Start false that the broker
   * answers with Session Present true sends them again before any new publication.
   */
  sessionState?: SessionState;
}

function captureSessionOptions(
  options: Readonly<SessionOptions>,
): Readonly<{ cleanStart: boolean; sessionExpiryInterval: number | undefined; session: SessionBinding | undefined }> {
  const {
    cleanStart = true,
    sessionExpiryInterval,
    sessionState,
  }: Readonly<Partial<Record<keyof SessionOptions, unknown>>> = options;
  if (typeof cleanStart !== 'boolean') throw new MqttError('ERR_MQTT_INVALID_ARGUMENT', 'MQTT cleanStart must be a boolean');
  if (
    sessionExpiryInterval !== undefined &&
    (typeof sessionExpiryInterval !== 'number' ||
      !Number.isInteger(sessionExpiryInterval) ||
      sessionExpiryInterval < 0 ||
      sessionExpiryInterval > 0xffff_ffff)
  )
    throw new MqttError('ERR_MQTT_INVALID_ARGUMENT', 'MQTT sessionExpiryInterval must be an integer from 0 to 4294967295');
  const session = sessionBinding(sessionState);
  if (sessionState !== undefined && session === undefined)
    throw new MqttError('ERR_MQTT_INVALID_ARGUMENT', 'MQTT sessionState must come from createSessionState()');
  return { cleanStart, sessionExpiryInterval, session };
}

/**
 * A client factory over a byte transport. The first `connect()` opens the transport, and later calls return the same
 * promise. `platform` supplies the framer and the payload type.
 */
export function createByteClient<Bytes extends Uint8Array>(
  transport: Readonly<ByteTransport>,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The core keeps native signals and payload views by identity.
  options: Readonly<ByteClientOptions<Bytes>>,
  platform: Readonly<BytePlatform<Bytes>>,
): ClientFactory {
  let connection: Promise<ClientSession> | undefined;
  return {
    // oxlint-disable-next-line typescript/promise-function-async -- Forward the existing promise without adding an async wrapper.
    connect() {
      if (connection) return connection;
      let start = () => {};
      connection = new Promise((resolve, reject) => {
        start = () => {
          void connectOverBytes(transport, options, platform).then(resolve, reject);
        };
      });
      // The opener can call connect() before it returns its writer.
      start();
      return connection;
    },
  };
}

/**
 * Own one connection attempt over `transport`: abort, framing and inbound rules, encoding, the write budget and teardown.
 * The transport only opens its connection and adapts its calls.
 */
async function connectOverBytes<Bytes extends Uint8Array>(
  transport: Readonly<ByteTransport>,
  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The core keeps native signals and payload views by identity.
  options: Readonly<ByteClientOptions<Bytes>>,
  platform: Readonly<BytePlatform<Bytes>>,
): Promise<ClientSession> {
  const { name, supportsSharedSubscriptions = true, supportsPassword = true } = transport;
  const { onDiagnostic, onSessionEnd, onQosOneMessage, signal } = options;
  const isAborted = (): boolean => signal?.aborted === true;
  const abortReason = () => {
    const reason: unknown = signal?.reason;
    return reason instanceof Error
      ? reason
      : Object.assign(new MqttError('ERR_MQTT_ABORTED', name + ' connection aborted', { cause: reason }), { name: 'AbortError' });
  };
  if (isAborted()) throw abortReason();

  const timeoutMs = resolveTimeout(options.timeoutMs);
  const publicationLimits = resolvePublicationLimits(options);
  const subscriptionLimits = resolveSubscriptionLimits(options);
  const writeLimits = resolveNativeWriteLimits(options);
  const input = new PacketInput(options.maxPacketBytes, platform);
  let will: WillMessage | undefined;
  let password: Uint8Array | undefined;
  let session: ReturnType<typeof captureSessionOptions>;
  try {
    password = supportsPassword ? capturePassword(options.password) : undefined;
    will = captureWill(options.will);
    session = captureSessionOptions(options);
  } catch (error) {
    if (isAborted()) throw abortReason();
    throw invalidOption(error, 'Invalid MQTT connection option');
  }

  // Cancels the open while no writer exists.
  const opening = new AbortController();
  let writer: ByteWriterWithFlush | undefined;
  let forcedClose: Promise<void> | undefined;
  // Whether the transport reported its end, a failure or input the core rejected.
  let inputEnded = false;
  const release = () => {
    signal?.removeEventListener('abort', abort);
  };
  const forceClose = async (opened: Readonly<ByteWriter>): Promise<void> => {
    if (forcedClose) return forcedClose;
    let start = () => {};
    forcedClose = new Promise<void>((resolve, reject) => {
      start = () => {
        try {
          resolve(opened.close(true));
        } catch (error) {
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- A custom writer's synchronous throw has the same outcome as its rejected close promise.
          reject(error);
        }
      };
    });
    // A writer can report end or failure synchronously while closing.
    start();
    await forcedClose;
  };
  // Between the open resolving and `writer` being set, neither branch reaches the transport. The session's `listen` then
  // reports the recorded failure at once, and the core closes the writer when `connectPortable` rejects.
  const teardown = (reason: Readonly<Error>) => {
    if (!writer) {
      opening.abort(reason);
      return;
    }
    // The input already holds the outcome, so a failing close has nothing left to report.
    void forceClose(writer).catch(() => {});
  };
  const finish = (reason: Readonly<Error> | undefined) => {
    release();
    if (inputEnded || reason === undefined) return;
    inputEnded = true;
    teardown(reason);
  };
  const abort = () => {
    release();
    const reason = input.retire('abort', abortReason()) ?? abortReason();
    teardown(reason);
  };
  signal?.addEventListener('abort', abort, { once: true });

  const inbound: ByteInbound = {
    // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native byte views are mutable; the framer copies admitted input.
    bytes(chunk) {
      const reason = input.push(chunk);
      if (reason) finish(reason);
    },
    end(reason) {
      let selected: Readonly<Error> | undefined;
      try {
        selected = input.remoteEnd(reason ?? new MqttError('ERR_MQTT_TRANSPORT', name + ' connection closed'));
      } finally {
        finish(selected ?? input.reason);
      }
    },
    fail(error) {
      try {
        input.retire('error', error);
      } finally {
        // A broken transport is closed even when a graceful close already owns the input.
        finish(input.reason ?? error);
      }
    },
  };

  try {
    if (isAborted()) throw abortReason();
    try {
      writer = await transport.open(inbound, { signal: opening.signal, timeoutMs, maxPacketBytes: input.maxPacketBytes });
    } catch (error) {
      throw input.reason ?? transportFailure(error, name + ' open failed');
    }
    const opened = writer;
    const packets: PacketTransport<Bytes> = {
      supportsSharedSubscriptions,
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The session hands over mutable packets.
      async send(packet) {
        const bytes = encodePacket(packet, { sharedSubscriptions: supportsSharedSubscriptions });
        const wireBytes = bytes.length + (opened.frameOverhead?.(bytes.length) ?? 0);
        const traffic = packet.cmd === 'publish' ? 'publication' : 'control';
        let allowed = allowsNativeWrite(writeLimits, opened.bufferedBytes, wireBytes, traffic);
        if (!allowed && opened[flushNativeWrites] !== undefined) {
          opened[flushNativeWrites]();
          allowed = allowsNativeWrite(writeLimits, opened.bufferedBytes, wireBytes, traffic);
        }
        if (!allowed) {
          throw recordNativeBudgetFailure(packet, new Error(name + ' write budget exceeded'));
        }
        try {
          await opened.write(bytes);
        } catch (cause) {
          if (packet.cmd === 'connect') {
            // A failed CONNECT write must stop accepted input before the exchange unwinds.
            if (cause instanceof Error) input.retire('error', cause);
            else input.detachCore();
          }
          throw cause;
        }
      },
      listen(onPacket, onClose, onProtocolError) {
        return input.listen(onPacket, onClose, onQosOneMessage !== undefined, onProtocolError);
      },
      async close(force) {
        input.detachCore();
        try {
          if (force === true) {
            release();
            await forceClose(opened);
          } else {
            if (forcedClose === undefined) await opened.close(false);
            if (forcedClose !== undefined) await forcedClose;
          }
        } finally {
          release();
        }
      },
    };
    // If the transport ended or failed while it opened, `listen` reports that at once and the session fails before it writes.
    try {
      const client = await connectPortable(packets, {
        clientId: options.clientId,
        username: options.username,
        password,
        will,
        ...session,
        onMessage: options.onMessage,
        onDiagnostic,
        onSessionEnd,
        ...publicationLimits,
        ...subscriptionLimits,
        timeoutMs,
        onQosOneMessage,
      });
      if (isAborted()) throw abortReason();
      return client;
    } catch (error) {
      // The session's error is the outcome; a failing close must not replace it.
      await packets.close(true).catch(() => {});
      throw error;
    }
  } catch (error) {
    input.detachCore();
    release();
    throw error;
  }
}
