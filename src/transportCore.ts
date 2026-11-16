import { encodePacket } from './codec.js';
import type { ByteInbound, ByteTransport, ByteWriter } from './byteTransport.js';
import { NodePacketInput } from './nodePacketInput.js';
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

export interface ByteClientOptions extends PortableOptions<Buffer>, NativeWriteLimits {
  signal?: AbortSignal;
  maxPacketBytes?: number;
}

/** A client factory over a byte transport. The first `connect()` opens the transport, and later calls return the same promise. */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The core keeps native signals and Buffer payloads by identity.
export function createByteClient(transport: Readonly<ByteTransport>, options: Readonly<ByteClientOptions>): ClientFactory {
  let connection: Promise<ClientSession> | undefined;
  return {
    // oxlint-disable-next-line typescript/promise-function-async -- Forward the existing promise without adding an async wrapper.
    connect() {
      connection ??= connectOverBytes(transport, options);
      return connection;
    },
  };
}

/**
 * Own one connection attempt over `transport`: abort, framing and inbound rules, encoding, the write budget and teardown.
 * The transport only opens its connection and adapts its calls.
 */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- The core keeps native signals and Buffer payloads by identity.
async function connectOverBytes(transport: Readonly<ByteTransport>, options: Readonly<ByteClientOptions>): Promise<ClientSession> {
  const { name } = transport;
  const { onDiagnostic, onSessionEnd, onQosOneMessage, signal } = options;
  const isAborted = (): boolean => signal?.aborted === true;
  const abortReason = () => {
    const reason: unknown = signal?.reason;
    return reason instanceof Error ? reason : Object.assign(new Error(name + ' connection aborted'), { name: 'AbortError' });
  };
  if (isAborted()) throw abortReason();

  const timeoutMs = resolveTimeout(options.timeoutMs);
  const publicationLimits = resolvePublicationLimits(options);
  const subscriptionLimits = resolveSubscriptionLimits(options);
  const writeLimits = resolveNativeWriteLimits(options);
  const input = new NodePacketInput(options.maxPacketBytes);

  // Cancels the open while no writer exists.
  const opening = new AbortController();
  let writer: ByteWriter | undefined;
  // Whether the transport reported its end, a failure or input the core rejected.
  let inputEnded = false;
  const release = () => {
    signal?.removeEventListener('abort', abort);
  };
  const teardown = (reason: Readonly<Error>) => {
    if (writer) writer.close(true).catch(() => {});
    else opening.abort(reason);
  };
  const finish = (reason: Readonly<Error> | undefined) => {
    release();
    if (inputEnded || reason === undefined) return;
    inputEnded = true;
    teardown(reason);
  };
  const abort = () => {
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
        selected = input.remoteEnd(reason ?? new Error(name + ' connection closed'));
      } finally {
        finish(selected ?? input.reason);
      }
    },
    fail(error) {
      try {
        input.retire('error', error);
      } finally {
        finish(input.reason);
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
    const packets: PacketTransport<Buffer> = {
      // oxlint-disable-next-line typescript/promise-function-async, typescript/prefer-readonly-parameter-types -- Forward the writer's promise without adding an async wrapper. The session hands over mutable packets.
      send(packet) {
        return new Promise((resolve, reject) => {
          const bytes = encodePacket(packet, { sharedSubscriptions: true });
          const wireBytes = bytes.length + (opened.frameOverhead?.(bytes.length) ?? 0);
          const traffic = packet.cmd === 'publish' ? 'publication' : 'control';
          if (!allowsNativeWrite(writeLimits, opened.bufferedBytes, wireBytes, traffic)) {
            reject(recordNativeBudgetFailure(packet, new Error(name + ' write budget exceeded')));
            return;
          }
          opened.write(bytes).then(resolve, reject);
        });
      },
      listen(onPacket, onClose, onProtocolError) {
        return input.listen(onPacket, onClose, onQosOneMessage !== undefined, onProtocolError);
      },
      async close(force) {
        input.detachCore();
        if (force === true) release();
        await opened.close(force === true);
      },
    };
    // If the transport ended or failed while it opened, `listen` reports that at once and the session fails before it writes.
    try {
      const client = await connectPortable(packets, {
        clientId: options.clientId,
        username: options.username,
        password: options.password,
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
      await packets.close(true);
      throw error;
    }
  } catch (error) {
    input.detachCore();
    release();
    throw error;
  }
}
