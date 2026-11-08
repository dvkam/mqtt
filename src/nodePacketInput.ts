import type { PacketTransport } from './portable.js';
import type { NodeMessage } from './nodeMessage.js';
import { NodePacketDecoder } from './nodePacketDecoder.js';
import { nodePacketListener } from './nodePacketListener.js';
type PacketSink = Parameters<PacketTransport<NodeMessage>['listen']>[0];
type FailureSink = Parameters<PacketTransport<NodeMessage>['listen']>[1];
export class NodePacketInput {
  private readonly decoder: NodePacketDecoder;
  private packetSink: ReturnType<typeof nodePacketListener> | undefined;
  private failureSink: FailureSink | undefined;
  constructor(maxPacketBytes?: number) {
    this.decoder = new NodePacketDecoder({ maxPacketBytes, onPacket: (packet) => { this.packetSink?.(packet); } });
  }
  get reason(): Error | undefined { return undefined; }
  listen(onPacket: PacketSink, onClose: FailureSink): () => void {
    this.packetSink = nodePacketListener(onPacket);
    this.failureSink = onClose;
    return () => { this.detachCore(); };
  }
  push(bytes: Readonly<Uint8Array>): Error | undefined {
    try { this.decoder.push(bytes); return undefined; }
    catch (reason) { return this.retire('error', reason instanceof Error ? reason : new Error('MQTT input failed')); }
  }
  retire(_kind: 'error' | 'abort', reason: Readonly<Error>): Error | undefined {
    this.decoder.stop(reason); this.failureSink?.(reason); return reason;
  }
  remoteEnd(reason: Readonly<Error>): Error | undefined {
    this.decoder.finish(); this.decoder.stop(reason); this.failureSink?.(reason); return reason;
  }
  detachCore(): void { this.packetSink = undefined; this.failureSink = undefined; }
}
