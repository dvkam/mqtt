import { ProtocolInputError } from './protocolInputError.js';
import type { PacketTransport } from './portable.js';
import type { NodeMessage } from './nodeMessage.js';
import { validateInboundTopic } from './inboundTopic.js';
import { NodePacketDecoder } from './nodePacketDecoder.js';
import { nodePacketListener } from './nodePacketListener.js';

type PacketSink = Parameters<PacketTransport<NodeMessage>['listen']>[0];
type FailureSink = Parameters<PacketTransport<NodeMessage>['listen']>[1];
type ProtocolErrorSink = Parameters<PacketTransport<NodeMessage>['listen']>[2];
type Registration = Readonly<{
  received: ReturnType<typeof nodePacketListener>;
  failed: FailureSink;
  protocolError: ProtocolErrorSink;
}>;
type Termination = Readonly<{ owner: 'input'; kind: 'error' | 'abort' | 'remote'; reason: Error } | { owner: 'core' }>;

export class NodePacketInput {
  private readonly decoder: NodePacketDecoder;
  private registration: Registration | undefined;
  private registered = false;
  private terminal: Termination | undefined;

  constructor(maxPacketBytes?: number) {
    this.decoder = new NodePacketDecoder({
      maxPacketBytes,
      // oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- Forward decoded packets without copying their byte views.
      onPacket: (packet, length) => {
        if (packet.cmd === 'publish') validateInboundTopic(packet.topic, packet.topicAlias !== undefined);
        this.registration?.received(packet, length);
      },
    });
  }

  get reason(): Error | undefined {
    return this.terminal?.owner === 'input' ? this.terminal.reason : undefined;
  }

  listen(onPacket: PacketSink, onClose: FailureSink, receiveQosOne = false, protocolError?: ProtocolErrorSink): () => void {
    if (this.registered) throw new Error('Node packet input already registered');
    if (this.terminal?.owner === 'core') throw new Error('Node packet input has retired');
    this.registered = true;
    const registration: Registration = {
      received: nodePacketListener(onPacket, receiveQosOne),
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
