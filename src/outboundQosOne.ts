import type { IdentifierLease, PacketIdentifiers } from './packetIdentifiers.js';
import { MqttError } from './mqttError.js';

interface Publication<Item> {
  readonly outgoing: Item;
  readonly releaseBudget: () => void;
  readonly detach: () => void;
  readonly cancelIfAborted: () => boolean;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
}

interface Exchange<Item> {
  readonly publication: Publication<Item>;
  readonly identifier: IdentifierLease;
  /** Whether a resumed session sends the publication again with DUP set. */
  readonly resent: boolean;
  readonly acknowledge: (code: number) => void;
  readonly rejectAck: (reason: Readonly<Error>) => void;
  acknowledgmentCode: number | undefined;
}

const noneInFlight: readonly never[] = [];

type Transmit<Item> = (outgoing: Item, messageId: number, acknowledgment: Readonly<Promise<number>>) => Promise<number>;

function ignore(): void {}

/** A publication of an earlier connection that a resumed session sends again. No caller waits for it. */
function resentPublication<Item>(outgoing: Item): Publication<Item> {
  return { outgoing, releaseBudget: ignore, detach: ignore, cancelIfAborted: () => false, resolve: ignore, reject: ignore };
}

interface Resend<Item> {
  readonly publication: Publication<Item>;
  readonly identifier: IdentifierLease;
}

function reportAcknowledgment<Item>(publication: Readonly<Publication<Item>>, code: number): void {
  if (code >= 128)
    publication.reject(new MqttError('ERR_MQTT_REFUSED', 'MQTT publication refused', { fatal: false, reasonCode: code }));
  else publication.resolve();
}

/** Ordered QoS 1 exchanges. `Item` is the publication the session hands to `transmit`; the queue never reads it. */
export class OutboundQosOne<Item> {
  private readonly queued = new Set<Publication<Item>>();
  private readonly resends: Resend<Item>[] = [];
  // Whether queued publications wait for `release`, because resends are not all written yet.
  private holding = false;
  private readonly active = new Map<number, Exchange<Item>>();
  private readonly quota: number;
  private readonly identifiers: Readonly<Pick<PacketIdentifiers, 'reserve'>>;
  private readonly transmit: Transmit<Item>;
  private readonly dispatched: ((outgoing: Item, messageId: number) => void) | undefined;
  private retransmit: Transmit<Item>;
  private stopped?: Readonly<Error>;
  private activeSettled?: () => void;
  private draining = false;

  /**
   * `dispatched` learns the Packet Identifier of each new exchange before `transmit` writes it. When it throws, the
   * publication rejects with that error and its identifier returns.
   */
  constructor(
    quota: number,
    identifiers: Readonly<Pick<PacketIdentifiers, 'reserve'>>,
    transmit: Transmit<Item>,
    dispatched?: (outgoing: Item, messageId: number) => void,
  ) {
    this.quota = quota;
    this.identifiers = identifiers;
    this.transmit = transmit;
    this.retransmit = transmit;
    this.dispatched = dispatched;
  }

  async enqueue(outgoing: Item, releaseBudget: () => void, signal?: Readonly<AbortSignal>): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.stopped) {
        releaseBudget();
        reject(this.stopped);
        return;
      }
      let cancellation: AbortSignal | undefined;
      const publication: Publication<Item> = { outgoing, releaseBudget, detach, cancelIfAborted, resolve, reject };
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

  /**
   * Send the publications of an earlier connection again with `retransmit`, in the order given. Each keeps the Packet
   * Identifier lease the caller claimed for it. Queued publications stay queued, and so cancelable, until `release`.
   */
  resume(entries: readonly (readonly [Item, IdentifierLease])[], retransmit: Transmit<Item>): void {
    this.retransmit = retransmit;
    this.holding = true;
    for (const [outgoing, identifier] of entries) this.resends.push({ publication: resentPublication(outgoing), identifier });
    this.drain();
  }

  /** Dispatch the queued publications that `resume` held back. */
  release(): void {
    this.holding = false;
    this.drain();
  }

  /** Returns `resent` or `sent` when the PUBACK matches an active exchange, and undefined otherwise. */
  accept(messageId: number, code: number): 'resent' | 'sent' | undefined {
    const exchange = this.active.get(messageId);
    if (exchange === undefined || exchange.acknowledgmentCode !== undefined) return undefined;
    exchange.acknowledgmentCode = code;
    exchange.acknowledge(code);
    return exchange.resent ? 'resent' : 'sent';
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
    for (const { identifier } of this.resends) identifier.release();
    this.resends.length = 0;
  }

  /**
   * Rejects every publication with `reason`. Returns what `report` makes of each publication that was written but not
   * settled. `acknowledged` is true when a PUBACK below 0x80 arrived before the write settled.
   */
  retire<Report>(
    reason: Readonly<Error>,
    report: (outgoing: Item, messageId: number, acknowledged: boolean) => Report,
  ): readonly Report[] {
    this.stop(reason);
    let inFlight: Report[] | undefined;
    for (const [messageId, { publication, acknowledgmentCode }] of this.active)
      (inFlight ??= []).push(report(publication.outgoing, messageId, acknowledgmentCode !== undefined && acknowledgmentCode < 128));
    this.finishActive(reason, false);
    return inFlight ?? noneInFlight;
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
          // disconnect() started the drain, so the session no longer accepts work.
          const expired = new MqttError('ERR_MQTT_TIMEOUT', 'MQTT QoS 1 drain expired. Delivery outcome is unknown');
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
        const resend = this.resends.length === 0 ? undefined : this.resends.shift();
        if (resend !== undefined) {
          this.start(resend.publication, resend.identifier, true);
          continue;
        }
        if (this.holding) break;
        const publication = this.queued.values().next().value;
        if (publication === undefined) break;
        if (publication.cancelIfAborted()) continue;
        this.queued.delete(publication);
        let identifier: IdentifierLease | undefined;
        try {
          identifier = this.identifiers.reserve();
          this.dispatched?.(publication.outgoing, identifier.messageId);
        } catch (reason) {
          identifier?.release();
          publication.detach();
          publication.releaseBudget();
          publication.reject(reason);
          continue;
        }
        this.start(publication, identifier, false);
      }
    } finally {
      this.draining = false;
    }
  }

  private start(publication: Publication<Item>, identifier: IdentifierLease, resent: boolean): void {
    let acknowledge!: Exchange<Item>['acknowledge'];
    let rejectAck!: Exchange<Item>['rejectAck'];
    const acknowledgment = new Promise<number>((resolve, reject) => {
      acknowledge = resolve;
      rejectAck = reject;
    });
    const exchange: Exchange<Item> = { publication, identifier, resent, acknowledge, rejectAck, acknowledgmentCode: undefined };
    this.active.set(identifier.messageId, exchange);
    void this.complete(exchange, acknowledgment);
  }

  private async complete(exchange: Readonly<Exchange<Item>>, acknowledgment: Readonly<Promise<number>>): Promise<void> {
    const { publication, identifier } = exchange;
    try {
      const code = await (exchange.resent ? this.retransmit : this.transmit)(
        publication.outgoing,
        identifier.messageId,
        acknowledgment,
      );
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
