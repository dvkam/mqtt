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

/**
 * Where a QoS 2 exchange stands. `publish` waits for PUBREC. `accepted` has its PUBREC and has not handed PUBREL to the
 * transport. `release` has handed it over and waits for PUBCOMP. `complete` has its PUBCOMP and waits for the PUBLISH
 * and PUBREL writes.
 */
type Phase = 'publish' | 'accepted' | 'release' | 'complete';

interface Exchange<Item> {
  readonly publication: Publication<Item>;
  readonly identifier: IdentifierLease;
  /** Whether a resumed session continues the exchange of an earlier connection. */
  readonly resent: boolean;
  /** Settle the acknowledgment the exchange waits for: PUBACK at QoS 1, and PUBREC and then PUBCOMP at QoS 2. */
  acknowledge: (code: number) => void;
  rejectAck: (reason: Readonly<Error>) => void;
  /** The PUBACK reason code at QoS 1 and the PUBREC reason code at QoS 2. */
  acknowledgmentCode: number | undefined;
  /** Present on a QoS 2 exchange only, so QoS 1 exchanges share one object shape. */
  phase?: Phase;
  /**
   * On a QoS 2 exchange only. Enters the accepted phase, starts the PUBREL and sets `releasing`. `resent` is true when a
   * resumed session sends the PUBREL of an earlier connection again.
   */
  readonly release?: (resent: boolean) => void;
  /** The promise of the PUBCOMP reason code, once `release` ran. */
  releasing?: Readonly<Promise<number>>;
}

const noneInFlight: readonly never[] = [];

type Transmit<Item> = (outgoing: Item, messageId: number, acknowledgment: Readonly<Promise<number>>) => Promise<number>;

/**
 * Write PUBREL and wait for the PUBCOMP reason code in `completion`. `resent` is true when a resumed session sends the
 * PUBREL of an earlier connection again. It must observe `completion` even when it writes nothing, and it must call
 * `released` in the step that hands the PUBREL to the transport.
 */
type Release = (messageId: number, completion: Readonly<Promise<number>>, resent: boolean) => Promise<number>;

/**
 * An exchange that a resumed session continues, with the Packet Identifier lease the caller claimed for it. `phase` is
 * absent at QoS 1. At QoS 2, `publish` sends the PUBLISH again and `release` sends only the PUBREL.
 */
export type Resumed<Item> = readonly [outgoing: Item, identifier: IdentifierLease, phase?: 'publish' | 'release'];

function ignore(): void {}

/** A publication of an earlier connection that a resumed session sends again. No caller waits for it. */
function resentPublication<Item>(outgoing: Item): Publication<Item> {
  return { outgoing, releaseBudget: ignore, detach: ignore, cancelIfAborted: () => false, resolve: ignore, reject: ignore };
}

/** A PUBLISH of an earlier connection that waits for a quota slot. `twoPhase` is true at QoS 2. */
interface Resend<Item> {
  readonly publication: Publication<Item>;
  readonly identifier: IdentifierLease;
  readonly twoPhase: boolean;
}

function reportAcknowledgment<Item>(publication: Readonly<Publication<Item>>, code: number): void {
  if (code >= 128)
    publication.reject(new MqttError('ERR_MQTT_REFUSED', 'MQTT publication refused', { fatal: false, reasonCode: code }));
  else publication.resolve();
}

/**
 * Ordered QoS 1 and QoS 2 exchanges under one Receive Maximum quota. The class keeps the name of its first use, which
 * `AGENTS.md` and the verification models cite. `Item` is the publication the session hands to
 * `transmit`; the queue never reads it. A QoS 2 exchange keeps its quota slot and Packet Identifier until its PUBCOMP,
 * or until a PUBREC with a reason code of 0x80 or above.
 */
export class OutboundQosOne<Item> {
  private readonly queued = new Set<Publication<Item>>();
  private readonly resends: Resend<Item>[] = [];
  // Whether queued publications wait for `releaseQueued`, because resends are not all written yet.
  private holding = false;
  private readonly active = new Map<number, Exchange<Item>>();
  private readonly quota: number;
  private readonly identifiers: Readonly<Pick<PacketIdentifiers, 'reserve'>>;
  private readonly transmit: Transmit<Item>;
  private readonly dispatched: ((outgoing: Item, messageId: number) => void) | undefined;
  private readonly release: Release;
  private readonly twoPhase: (outgoing: Item) => boolean;
  private retransmit: Transmit<Item>;
  private stopped?: Readonly<Error>;
  private activeSettled?: () => void;
  private draining = false;

  /**
   * `twoPhase` says whether a publication is QoS 2, whose exchange continues with `release` after an accepting PUBREC.
   * `dispatched` learns the Packet Identifier of each new exchange before `transmit` writes it. When it throws, the
   * publication rejects with that error and its identifier returns.
   */
  constructor(
    quota: number,
    identifiers: Readonly<Pick<PacketIdentifiers, 'reserve'>>,
    transmit: Transmit<Item>,
    release: Release,
    twoPhase: (outgoing: Item) => boolean,
    dispatched?: (outgoing: Item, messageId: number) => void,
  ) {
    this.quota = quota;
    this.identifiers = identifiers;
    this.transmit = transmit;
    this.retransmit = transmit;
    this.release = release;
    this.twoPhase = twoPhase;
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
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Removing it would cost developer experience. The publish promise rejects with `AbortSignal.reason` as the caller set it, which may be a symbol or a string, and the queued cancellation test in test/qos1-publish.test.ts checks that the caller catches that same value. `cancel` settles a promise that another function created, so it cannot throw the value instead.
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
   * Continue the exchanges of an earlier connection in the order given. A PUBLISH goes out again through `retransmit`
   * when the quota has a slot for it. Every PUBREL starts here, because the quota holds back only PUBLISH packets
   * (MQTT 5 section 4.9). Its exchange still takes a slot from the PUBLISH packets that follow until its PUBCOMP. Queued
   * publications stay queued, and so cancelable, until `releaseQueued`.
   */
  resume(entries: readonly Resumed<Item>[], retransmit: Transmit<Item>): void {
    this.retransmit = retransmit;
    this.holding = true;
    for (const [outgoing, identifier, phase] of entries) {
      const publication = resentPublication(outgoing);
      if (phase === 'release') this.startTwoPhase(publication, identifier, true, true);
      else this.resends.push({ publication, identifier, twoPhase: phase === 'publish' });
    }
    this.drain();
  }

  /** Dispatch the queued publications that `resume` held back. */
  releaseQueued(): void {
    this.holding = false;
    this.drain();
  }

  /** Returns `resent` or `sent` when the PUBACK matches an active QoS 1 exchange, and undefined otherwise. */
  accept(messageId: number, code: number): 'resent' | 'sent' | undefined {
    const exchange = this.active.get(messageId);
    if (exchange === undefined || exchange.acknowledgmentCode !== undefined || exchange.phase !== undefined) return undefined;
    exchange.acknowledgmentCode = code;
    exchange.acknowledge(code);
    return exchange.resent ? 'resent' : 'sent';
  }

  /**
   * A PUBREC arrived. Returns `resent` or `sent` when it is the first PUBREC of an active QoS 2 exchange. Returns
   * `ignored` when the Packet Identifier belongs to another exchange, which the PUBREC leaves as it is. That exchange is
   * active, or it is a PUBLISH of an earlier connection that waits for a quota slot and goes out again. Returns undefined
   * when no exchange has the Packet Identifier.
   */
  received(messageId: number, code: number): 'resent' | 'sent' | 'ignored' | undefined {
    const exchange = this.active.get(messageId);
    if (exchange === undefined)
      return this.resends.some(({ identifier }) => identifier.messageId === messageId) ? 'ignored' : undefined;
    if (exchange.phase !== 'publish' || exchange.acknowledgmentCode !== undefined) return 'ignored';
    exchange.acknowledgmentCode = code;
    const { acknowledge } = exchange;
    // MQTT-4.6.0-4: each PUBREL goes out when its PUBREC arrives, so in PUBREC order, also while a PUBLISH write is pending.
    if (code < 128) exchange.release?.(false);
    acknowledge(code);
    return exchange.resent ? 'resent' : 'sent';
  }

  /** The PUBREL of an exchange is about to reach the transport, so a PUBCOMP can answer it from now on. */
  released(messageId: number): void {
    const exchange = this.active.get(messageId);
    if (exchange?.phase === 'accepted') exchange.phase = 'release';
  }

  /** Returns `resent` or `sent` when the PUBCOMP answers the PUBREL of an active QoS 2 exchange, and undefined otherwise. */
  completed(messageId: number, code: number): 'resent' | 'sent' | undefined {
    const exchange = this.active.get(messageId);
    if (exchange?.phase !== 'release') return undefined;
    exchange.phase = 'complete';
    exchange.acknowledge(code);
    return exchange.resent ? 'resent' : 'sent';
  }

  get hasActive(): boolean {
    return this.active.size > 0;
  }

  /** Rejects the queued publications and drops the resends that have not started. Returns how many resends it dropped. */
  stop(reason: Readonly<Error>): number {
    this.stopped ??= reason;
    for (const publication of this.queued) {
      publication.detach();
      publication.releaseBudget();
      publication.reject(this.stopped);
    }
    this.queued.clear();
    const dropped = this.resends.length;
    for (const { identifier } of this.resends) identifier.release();
    this.resends.length = 0;
    return dropped;
  }

  /**
   * Rejects every publication with `reason`. Returns what `report` makes of each publication that was written but not
   * settled. `acknowledged` is true when a PUBACK or a PUBREC with a reason below 0x80 arrived.
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
    for (const { publication, identifier, rejectAck, acknowledgmentCode, phase } of this.active.values()) {
      publication.detach();
      // An accepting PUBREC does not settle a QoS 2 publication. Its PUBCOMP does.
      const settled =
        acknowledgmentCode !== undefined && (phase === undefined || phase === 'complete' || acknowledgmentCode >= 128);
      if (preserveAcknowledgments && settled) reportAcknowledgment(publication, acknowledgmentCode);
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
          const expired = new MqttError('ERR_MQTT_TIMEOUT', 'MQTT publish drain expired. Delivery outcome is unknown');
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
          if (resend.twoPhase) this.startTwoPhase(resend.publication, resend.identifier, true, false);
          else this.start(resend.publication, resend.identifier, true);
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
        if (this.twoPhase(publication.outgoing)) this.startTwoPhase(publication, identifier, false, false);
        else this.start(publication, identifier, false);
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
      this.finish(exchange);
    }
  }

  /** `released` is true when a resumed session continues an exchange that has its PUBREC, so only PUBREL goes out. */
  private startTwoPhase(publication: Publication<Item>, identifier: IdentifierLease, resent: boolean, released: boolean): void {
    const { messageId } = identifier;
    let acknowledge: Exchange<Item>['acknowledge'] = ignore;
    let rejectAck: Exchange<Item>['rejectAck'] = ignore;
    const received = new Promise<number>((resolve, reject) => {
      acknowledge = resolve;
      rejectAck = reject;
    });
    const exchange: Exchange<Item> = {
      publication,
      identifier,
      resent,
      acknowledge,
      rejectAck,
      // An earlier connection received the PUBREC that accepted a released publication.
      acknowledgmentCode: released ? 0 : undefined,
      phase: 'publish',
      release: (resentRelease) => {
        const completion = new Promise<number>((resolve, reject) => {
          exchange.phase = 'accepted';
          exchange.acknowledge = resolve;
          exchange.rejectAck = reject;
        });
        const releasing = this.release(messageId, completion, resentRelease);
        // The exchange awaits this promise only after its PUBLISH step, which a session end can reject first.
        releasing.catch(ignore);
        exchange.releasing = releasing;
      },
      releasing: undefined,
    };
    this.active.set(messageId, exchange);
    void (async () => {
      try {
        if (released) exchange.release?.(true);
        else {
          const code = await (resent ? this.retransmit : this.transmit)(publication.outgoing, messageId, received);
          if (code >= 128) {
            reportAcknowledgment(publication, code);
            return;
          }
        }
        await exchange.releasing;
        publication.resolve();
      } catch (reason) {
        publication.reject(reason);
      } finally {
        this.finish(exchange);
      }
    })();
  }

  /** Return what a settled exchange held, and dispatch what waited for its quota slot. */
  private finish(exchange: Readonly<Exchange<Item>>): void {
    const { publication, identifier } = exchange;
    publication.detach();
    publication.releaseBudget();
    if (this.active.get(identifier.messageId) === exchange) this.active.delete(identifier.messageId);
    identifier.release();
    if (this.activeSettled !== undefined) this.reportActiveSettled();
    this.drain();
  }
}
