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
import { MqttError } from './mqttError.js';

export interface ByteClientOptions<Bytes extends Uint8Array = Uint8Array> extends PortableOptions<Bytes>, NativeWriteLimits {
  signal?: AbortSignal;
  maxPacketBytes?: number;
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
      : Object.assign(new MqttError('ERR_MQTT_ABORTED', name + ' connection aborted'), { name: 'AbortError' });
  };
  if (isAborted()) throw abortReason();

  const timeoutMs = resolveTimeout(options.timeoutMs);
  const publicationLimits = resolvePublicationLimits(options);
  const subscriptionLimits = resolveSubscriptionLimits(options);
  const writeLimits = resolveNativeWriteLimits(options);
  const input = new PacketInput(options.maxPacketBytes, platform);

  // Cancels the open while no writer exists.
  const opening = new AbortController();
  let writer: ByteWriter | undefined;
  // Whether the transport reported its end, a failure or input the core rejected.
  let inputEnded = false;
  const release = () => {
    signal?.removeEventListener('abort', abort);
  };
  // Between the open resolving and `writer` being set, neither branch reaches the transport. The session's `listen` then
  // reports the recorded failure at once, and the core closes the writer when `connectPortable` rejects.
  const teardown = (reason: Readonly<Error>) => {
    if (!writer) {
      opening.abort(reason);
      return;
    }
    // The input already holds the outcome, so a failing close has nothing left to report. Catch a synchronous throw
    // too, because it would otherwise escape from the transport's event handler.
    try {
      writer.close(true).catch(() => {});
    } catch {
      // See above.
    }
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
    try {
      writer = await transport.open(inbound, { signal: opening.signal, timeoutMs });
    } catch (error) {
      throw input.reason ?? error;
    }
    const opened = writer;
    const packets: PacketTransport<Bytes> = {
      supportsSharedSubscriptions,
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The session hands over mutable packets.
      async send(packet) {
        const bytes = encodePacket(packet, { sharedSubscriptions: supportsSharedSubscriptions });
        const wireBytes = bytes.length + (opened.frameOverhead?.(bytes.length) ?? 0);
        const traffic = packet.cmd === 'publish' ? 'publication' : 'control';
        if (!allowsNativeWrite(writeLimits, opened.bufferedBytes, wireBytes, traffic)) {
          throw recordNativeBudgetFailure(packet, new Error(name + ' write budget exceeded'));
        }
        await opened.write(bytes);
      },
      listen(onPacket, onClose, onProtocolError) {
        return input.listen(onPacket, onClose, onQosOneMessage !== undefined, onProtocolError);
      },
      async close(force) {
        input.detachCore();
        if (force === true) release();
        await opened.close(force === true);
        // The writer settles once closed, or once it stopped waiting for the peer, so nothing is left to abort.
        release();
      },
    };
    // If the transport ended or failed while it opened, `listen` reports that at once and the session fails before it writes.
    try {
      const client = await connectPortable(packets, {
        clientId: options.clientId,
        username: options.username,
        password: supportsPassword ? options.password : undefined,
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
