import type { IdentifierLease, PacketIdentifiers } from './packetIdentifiers.js';
import { MqttError } from './mqttError.js';

interface Publication {
  readonly topic: string;
  readonly payload: string;
  readonly releaseBudget: () => void;
  readonly detach: () => void;
  readonly cancelIfAborted: () => boolean;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

interface Exchange {
  readonly publication: Publication;
  readonly identifier: IdentifierLease;
  readonly acknowledge: (code: number) => void;
  readonly rejectAck: (reason: Readonly<Error>) => void;
  acknowledgmentCode: number | undefined;
}

type Transmit = (topic: string, payload: string, messageId: number, acknowledgment: Readonly<Promise<number>>) => Promise<number>;

function reportAcknowledgment(publication: Readonly<Publication>, code: number): void {
  if (code >= 128)
    publication.reject(new MqttError('ERR_MQTT_REFUSED', 'MQTT publication refused', { fatal: false, reasonCode: code }));
  else publication.resolve();
}

export class OutboundQosOne {
  private readonly queued = new Set<Publication>();
  private readonly active = new Map<number, Exchange>();
  private readonly quota: number;
  private readonly identifiers: Readonly<Pick<PacketIdentifiers, 'reserve'>>;
  private readonly transmit: Transmit;
  private stopped?: Readonly<Error>;
  private activeSettled?: () => void;
  private draining = false;

  constructor(quota: number, identifiers: Readonly<Pick<PacketIdentifiers, 'reserve'>>, transmit: Transmit) {
    this.quota = quota;
    this.identifiers = identifiers;
    this.transmit = transmit;
  }

  async enqueue(topic: string, payload: string, releaseBudget: () => void, signal?: Readonly<AbortSignal>): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) {
        releaseBudget();
        reject(this.stopped);
        return;
      }
      let cancellation: AbortSignal | undefined;
      const publication: Publication = { topic, payload, releaseBudget, detach, cancelIfAborted, resolve, reject };
      const queue = this.queued;
      function detach() {
        cancellation?.removeEventListener('abort', cancel);
      }
      function cancel() {
        detach();
        if (queue.delete(publication)) releaseBudget();
        const reason: unknown = cancellation?.reason;
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- AbortSignal.reason can be a symbol. The queued cancellation regression checks that callers receive it unchanged.
        reject(reason);
      }
      function cancelIfAborted(): boolean {
        if (cancellation?.aborted !== true) return false;
        cancel();
        return true;
      }
      queue.add(publication);
      try {
        // A listener on the caller's signal can stop event propagation.
        cancellation = signal === undefined ? undefined : AbortSignal.any([signal]);
        cancellation?.addEventListener('abort', cancel, { once: true });
      } catch (reason) {
        queue.delete(publication);
        releaseBudget();
        reject(reason instanceof Error ? reason : new Error('Unable to observe publish cancellation'));
        return;
      }
      cancelIfAborted();
      this.drain();
    });
  }

  accept(messageId: number, code: number): void {
    const exchange = this.active.get(messageId);
    if (exchange === undefined || exchange.acknowledgmentCode !== undefined) return;
    exchange.acknowledgmentCode = code;
    exchange.acknowledge(code);
  }

  get hasActive(): boolean {
    return this.active.size > 0;
  }

  stop(reason: Readonly<Error>): void {
    this.stopped ??= reason;
    for (const publication of this.queued) {
      publication.detach();
      publication.releaseBudget();
      publication.reject(this.stopped);
    }
    this.queued.clear();
  }

  retire(reason: Readonly<Error>): void {
    this.stop(reason);
    this.finishActive(reason, false);
  }

  private finishActive(reason: Readonly<Error>, preserveAcknowledgments: boolean): void {
    for (const { publication, identifier, rejectAck, acknowledgmentCode } of this.active.values()) {
      publication.detach();
      if (preserveAcknowledgments && acknowledgmentCode !== undefined) reportAcknowledgment(publication, acknowledgmentCode);
      else publication.reject(reason);
      rejectAck(reason);
      identifier.release();
    }
    this.active.clear();
    this.reportActiveSettled();
  }

  /** Call after stop(), so no new exchanges can join the set being drained. */
  async waitForActive(timeoutMs: number): Promise<void> {
    if (!this.hasActive) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve) => {
        this.activeSettled = resolve;
        timer = setTimeout(() => {
          const expired = new MqttError('ERR_MQTT_TIMEOUT', 'MQTT QoS 1 drain expired. Delivery outcome is unknown', {
            fatal: false,
          });
          this.finishActive(expired, true);
        }, timeoutMs);
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private reportActiveSettled(): void {
    const settled = this.activeSettled;
    if (settled === undefined || this.hasActive) return;
    this.activeSettled = undefined;
    settled();
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.stopped && this.active.size < this.quota) {
        const publication = this.queued.values().next().value;
        if (publication === undefined) break;
        if (publication.cancelIfAborted()) continue;
        this.queued.delete(publication);
        let identifier: IdentifierLease;
        try {
          identifier = this.identifiers.reserve();
        } catch (reason) {
          publication.detach();
          publication.releaseBudget();
          publication.reject(reason);
          continue;
        }
        let acknowledge!: Exchange['acknowledge'];
        let rejectAck!: Exchange['rejectAck'];
        const acknowledgment = new Promise<number>((resolve, reject) => {
          acknowledge = resolve;
          rejectAck = reject;
        });
        const exchange: Exchange = { publication, identifier, acknowledge, rejectAck, acknowledgmentCode: undefined };
        this.active.set(identifier.messageId, exchange);
        void this.complete(exchange, acknowledgment);
      }
    } finally {
      this.draining = false;
    }
  }

  private async complete(exchange: Readonly<Exchange>, acknowledgment: Readonly<Promise<number>>): Promise<void> {
    const { publication, identifier } = exchange;
    try {
      const code = await this.transmit(publication.topic, publication.payload, identifier.messageId, acknowledgment);
      reportAcknowledgment(publication, code);
    } catch (reason) {
      publication.reject(reason);
    } finally {
      publication.detach();
      publication.releaseBudget();
      if (this.active.get(identifier.messageId) === exchange) this.active.delete(identifier.messageId);
      identifier.release();
      if (this.activeSettled !== undefined) this.reportActiveSettled();
      this.drain();
    }
  }
}
