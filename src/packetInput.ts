import type { BytePlatform } from './bytePlatform.js';
import { inboundPacketListener } from './inboundPackets.js';
import { validateInboundTopic } from './inboundTopic.js';
import type { PacketFramer } from './packetFramer.js';
import type { PacketTransport } from './portable.js';
import { ProtocolInputError } from './protocolInputError.js';

type Listen<Bytes extends Uint8Array> = PacketTransport<Bytes>['listen'];
type PacketSink<Bytes extends Uint8Array> = Parameters<Listen<Bytes>>[0];
type FailureSink<Bytes extends Uint8Array> = Parameters<Listen<Bytes>>[1];
type ProtocolErrorSink<Bytes extends Uint8Array> = Parameters<Listen<Bytes>>[2];
type Registration<Bytes extends Uint8Array> = Readonly<{
  received: ReturnType<typeof inboundPacketListener>;
  failed: FailureSink<Bytes>;
  protocolError: ProtocolErrorSink<Bytes>;
}>;
type Termination = Readonly<{ owner: 'input'; kind: 'error' | 'abort' | 'remote'; reason: Error } | { owner: 'core' }>;

/**
 * Frames inbound bytes for one connection and owns its first terminal cause. The platform supplies the framer and the
 * payload type, so the same input serves Node and the browser.
 */
export class PacketInput<Bytes extends Uint8Array> {
  private readonly decoder: PacketFramer;
  private readonly toBytes: BytePlatform<Bytes>['bytes'];
  private registration: Registration<Bytes> | undefined;
  private registered = false;
  private terminal: Termination | undefined;

  constructor(maxPacketBytes: number | undefined, platform: BytePlatform<Bytes>) {
    this.toBytes = platform.bytes;
    this.decoder = platform.framer({
      maxPacketBytes,
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Forward decoded packets without copying their byte views.
      onPacket: (packet) => {
        if (packet.cmd === 'publish') validateInboundTopic(packet.topic, packet.topicAlias !== undefined);
        this.registration?.received(packet);
      },
    });
  }

  get reason(): Error | undefined {
    return this.terminal?.owner === 'input' ? this.terminal.reason : undefined;
  }

  listen(
    onPacket: PacketSink<Bytes>,
    onClose: FailureSink<Bytes>,
    receiveQosOne = false,
    protocolError?: ProtocolErrorSink<Bytes>,
  ): () => void {
    if (this.registered) throw new Error('Node packet input already registered');
    if (this.terminal?.owner === 'core') throw new Error('Node packet input has retired');
    this.registered = true;
    const registration: Registration<Bytes> = {
      received: inboundPacketListener(onPacket, receiveQosOne, this.toBytes),
      failed: onClose,
      protocolError,
    };
    this.registration = registration;
    if (this.terminal?.owner === 'input') registration.failed(this.terminal.reason);
    return () => {
      if (this.registration !== registration) return;
      this.detachCore();
    };
  }

  // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Native byte views are mutable; the decoder copies admitted input.
  push(bytes: Readonly<Uint8Array>): Error | undefined {
    if (this.terminal) return this.reason;
    try {
      this.decoder.push(bytes);
      return this.reason;
    } catch (reason) {
      const protocolError = this.registration?.protocolError;
      if (reason instanceof ProtocolInputError && protocolError) {
        this.detachCore();
        protocolError(reason);
        return undefined;
      }
      return this.retire('error', reason instanceof Error ? reason : new Error('MQTT input failed'));
    }
  }

  retire(kind: 'error' | 'abort', reason: Readonly<Error>): Error | undefined {
    if (this.terminal) return this.reason;
    this.terminal = { owner: 'input', kind, reason };
    this.decoder.stop(reason);
    this.notify();
    return reason;
  }

  remoteEnd(reason: Readonly<Error>): Error | undefined {
    if (this.terminal) return this.reason;
    let selected = reason;
    try {
      this.decoder.finish();
    } catch (failure) {
      selected = failure instanceof Error ? failure : new Error('MQTT input completion failed');
    }
    this.terminal = { owner: 'input', kind: 'remote', reason: selected };
    this.notify();
    return selected;
  }

  detachCore(): void {
    this.registration = undefined;
    if (this.terminal) return;
    this.terminal = { owner: 'core' };
    this.decoder.stop(new Error('Node packet decoder detached from core'));
  }

  private notify(): void {
    if (this.terminal?.owner === 'input') this.registration?.failed(this.terminal.reason);
  }
}
