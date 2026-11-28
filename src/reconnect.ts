import { notifyObserver } from './diagnostics.js';
import { validateTopic } from './util/validateTopic.js';
import { MqttError, ReceiveLimitError, transportFailure, type MqttErrorCode } from './mqttError.js';
import type {
  ClientFactory,
  ClientSession,
  DisconnectOptions,
  SessionEnd,
  SessionEndObserver,
  SubscribeResult,
  UncertainPublication,
} from './session.js';
import { bindSessionState, isSessionExpiryInterval, type SessionState } from './sessionState.js';

/** The factory options that `createReconnectingClient` reads, or replaces with its own on each attempt. */
export interface Reconnectable {
  /**
   * The Clean Start flag of each attempt. With `resume`, only the first attempt uses it. Later attempts send false once a
   * session connected, and true again after `resetSession()`. Without `resume`, false needs a `sessionState`.
   */
  cleanStart?: boolean;
  /**
   * The client passes it on unchanged. With `resume`, it must be an integer from 1 to 4,294,967,295, so the broker keeps
   * the session after a connection ends.
   */
  sessionExpiryInterval?: number;
  /** With `resume`, the client replaces it with its own session state, which every attempt shares. */
  sessionState?: SessionState;
  /** Called with every session end of every attempt, after the reconnecting client has handled that end. */
  onSessionEnd?: SessionEndObserver;
  /**
   * Aborting it stops the reconnecting client with reason `aborted`. Each attempt receives `AbortSignal.any` of this
   * signal and the client's own signal, which aborts when the client stops while the attempt opens.
   */
  signal?: AbortSignal;
}

/** A subscription the reconnecting client makes after every CONNACK, in the order given. */
export interface SubscriptionIntent {
  /** The topic filter. */
  readonly topic: string;
  /** The requested QoS. Defaults to 0. */
  readonly qos?: 0 | 1 | 2;
}

/** The outcome of one subscription after a CONNACK. A refused SUBACK keeps the session. */
export type SubscriptionRestore = Readonly<
  {
    /** The topic filter of the intent. */
    topic: string;
    /** The QoS the intent requested, 0 when it set none. */
    qos: 0 | 1 | 2;
  } & (
    | {
        /** The SUBACK result. */
        result: SubscribeResult;
      }
    | {
        /** The rejection of `subscribe()`, such as `ERR_MQTT_REFUSED` for a refused SUBACK. */
        error: unknown;
      }
  )
>;

/** What `onReconnect` receives. */
export type ReconnectEvent =
  | Readonly<{
      /**
       * A session connected and its subscriptions were made, or it resumed a broker session, and `session()` resolves
       * with it.
       */
      kind: 'connected';
      /** The number of sessions that connected, starting at 1. A failed attempt does not count. */
      generation: number;
      /** The number of attempts since the last stable session, starting at 1, including this one. */
      attempt: number;
      /** The session that connected. */
      session: Readonly<ClientSession>;
      /**
       * How the session of the previous `connected` event ended. Its `uncertain` field lists the QoS 1 and QoS 2
       * publications whose outcome is unknown. Failed attempts since then do not replace it. Absent on the first
       * `connected` event.
       */
      previous?: SessionEnd;
      /**
       * One outcome for each entry of `subscriptions` in the options, in the same order. Empty when `resumed` is true,
       * because the broker kept the subscriptions.
       */
      subscriptions: readonly SubscriptionRestore[];
      /** The CONNACK Session Present flag. True when the broker resumed the session that an earlier CONNECT started. */
      resumed: boolean;
      /**
       * With `resume`, the stored QoS 1 and QoS 2 publications that this session continues with their Packet Identifiers.
       * First come the QoS 2 publications that have their PUBREC, with `acknowledged` true. The session sends only their
       * PUBREL, and the broker's Receive Maximum does not hold a PUBREL back. The others follow in the order they were
       * first sent. The session sends each PUBLISH again with DUP set, within the Receive Maximum. Absent when there are
       * none. `puback`, `pubrec` and `pubcomp` events report the broker's answers. A publication that the session does
       * not finish before it ends stays stored, so a later `connected` event lists it in `resent` or `dropped` again.
       */
      resent?: readonly UncertainPublication[];
      /**
       * With `resume`, the stored QoS 1 and QoS 2 publications the client dropped since the last `connected` event, because the
       * broker answered with Session Present false or `resetSession()` was called. The client does not send them again,
       * and their outcome is unknown. Absent when there are none.
       */
      dropped?: readonly UncertainPublication[];
    }>
  | Readonly<{
      /**
       * The broker answered a publication that a resumed session continued. `puback` ends a QoS 1 publication that the
       * session sent again. `pubrec` answers a QoS 2 PUBLISH that the session sent again. Below 0x80 the broker has the
       * message and the session sends PUBREL. From 0x80 the broker refused it and the exchange ended. `pubcomp` ends a QoS 2
       * publication, after a PUBREL that followed that `pubrec` or that the session sent again.
       */
      kind: 'puback' | 'pubrec' | 'pubcomp';
      /** The topic it was published to. */
      topic: string;
      /** The Packet Identifier it was sent with. */
      messageId: number;
      /**
       * The reason code of the PUBACK, PUBREC or PUBCOMP. Below 0x80 means the broker accepted the publication. A PUBCOMP
       * carries 0, or 0x92 when the broker no longer knew the Packet Identifier, and both end the exchange.
       */
      reasonCode: number;
    }>
  | Readonly<{
      /** An attempt failed or a session ended, and the client waits before the next attempt. */
      kind: 'retrying';
      /** The number the next attempt will have, counted since the last stable session. */
      attempt: number;
      /** The wait before the next attempt, in milliseconds. */
      delayMs: number;
      /** The error that ended the attempt or the session. */
      error: Readonly<Error>;
    }>
  | Readonly<{
      /** The client stopped and opens no more connections. */
      kind: 'stopped';
      /**
       * `disconnect` after a disconnect call, `aborted` after the signal aborted, `refused` after a CONNACK refusal that
       * does not retry, `fatal` after another error that does not retry, and `exhausted` after `maxAttempts` attempts.
       */
      reason: 'disconnect' | 'aborted' | 'refused' | 'fatal' | 'exhausted';
      /** The error that `session()` now rejects with. Absent for reason `disconnect`. */
      error?: Readonly<Error>;
    }>;

/**
 * The reconnect policy. `createReconnectingClient` throws a RangeError at once when a number in it is invalid, or when
 * `resume` is set and the factory options have no `sessionExpiryInterval` from 1 to 4,294,967,295.
 */
export interface ReconnectOptions {
  /** Subscriptions to make after every CONNACK with Session Present false. */
  readonly subscriptions?: readonly SubscriptionIntent[];
  /**
   * Resume the MQTT session on later attempts. Every attempt after a connected session sends Clean Start false and shares
   * one session state, so a session the broker resumed continues the unfinished QoS 1 and QoS 2 exchanges and keeps its
   * subscriptions. Needs `sessionExpiryInterval` from 1 to 4,294,967,295 in the factory options. Defaults to false.
   */
  readonly resume?: boolean;
  /**
   * The ceiling of the delay before the second attempt, in milliseconds. The client draws the delay from half to all of
   * the ceiling, and the ceiling doubles for each later attempt. A finite number of 0 or more. Defaults to 1,000.
   */
  readonly initialDelayMs?: number;
  /**
   * The highest ceiling of the delay between attempts, in milliseconds. A finite number of 0 or more. A value below
   * `initialDelayMs` is raised to `initialDelayMs`. Defaults to 30,000.
   */
  readonly maxDelayMs?: number;
  /**
   * The number of attempts since the last stable session after which a failure stops the client with reason
   * `exhausted`. An attempt whose session connected but ended before `stableAfterMs` counts. A number of 0 or more, or
   * `Infinity` to retry forever. Defaults to 10.
   */
  readonly maxAttempts?: number;
  /**
   * A session that stays up this long, in milliseconds, is stable and resets the attempt count when it ends. A finite
   * number of 0 or more. Defaults to `maxDelayMs`.
   */
  readonly stableAfterMs?: number;
  /** A source of numbers in [0, 1) for the jitter. Defaults to Math.random. */
  readonly random?: () => number;
  /** Receives every `connected`, `retrying` and `stopped` event. A thrown error or a rejection is ignored. */
  readonly onReconnect?: (event: ReconnectEvent) => void | Promise<void>;
}

/** A client that opens a new session after each failure. */
export interface ReconnectingClient {
  /**
   * The current session, or the next one once it connects and its subscriptions are made. Repeated calls return the same
   * promise until that session ends. After the client stops, it rejects with the error of the `stopped` event, or with
   * `ERR_MQTT_CLOSING` after a disconnect.
   */
  session(): Promise<ClientSession>;
  /**
   * Starts the next attempt now when the client waits for its retry timer, and clears that timer. The attempt counts
   * toward `maxAttempts` as one the timer started would. Returns true when it started an attempt. While an attempt
   * opens, while a session is connected and after the client stopped, it does nothing and returns false.
   */
  retryNow(): boolean;
  /** Stops reconnecting, then disconnects the current session with `options`. */
  disconnect(options?: Readonly<DisconnectOptions>): Promise<void>;
  /**
   * With `resume`, start a new session on the next attempt. That attempt drops the stored QoS 1 and QoS 2 publications, lists them in
   * `dropped` of the next `connected` event and sends Clean Start true until a session connects. A connected session
   * keeps running. Has no effect without `resume`.
   */
  resetSession(): void;
}

// MQTT 5 CONNACK reasons worth another attempt: Server unavailable, Server busy, Quota exceeded, Connection rate exceeded.
const retryRefusals: ReadonlySet<number | undefined> = new Set([0x88, 0x89, 0x97, 0x9f]);
// Broker DISCONNECT reasons that stop: Malformed Packet, Protocol Error, Not authorized, Session taken over, Use another
// server and Server moved.
const stopDisconnects: ReadonlySet<number | undefined> = new Set([0x81, 0x82, 0x87, 0x8e, 0x9c, 0x9d]);
// The codes besides ERR_MQTT_REFUSED and ERR_MQTT_BROKER_DISCONNECT that retry. The reason code decides for those two.
const retryCodes: ReadonlySet<MqttErrorCode> = new Set(['ERR_MQTT_TRANSPORT', 'ERR_MQTT_TIMEOUT', 'ERR_MQTT_SESSION_CONFLICT']);

// The factories reject with a RangeError for an invalid option. Broker input over a receive limit is a RangeError too,
// either a ReceiveLimitError or the error with this code that ws/lib/receiver.js raises for a message over maxPayload.
const wsMessageTooLong = 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH';

type StopReason = Extract<ReconnectEvent, { kind: 'stopped' }>['reason'];

function stopReason(error: Readonly<Error>): 'refused' | 'fatal' | undefined {
  if (error instanceof MqttError) {
    if (error.code === 'ERR_MQTT_REFUSED') return retryRefusals.has(error.reasonCode) ? undefined : 'refused';
    if (error.code === 'ERR_MQTT_BROKER_DISCONNECT') return stopDisconnects.has(error.reasonCode) ? 'fatal' : undefined;
    return retryCodes.has(error.code) ? undefined : 'fatal';
  }
  if (!(error instanceof RangeError) || error instanceof ReceiveLimitError) return undefined;
  return 'code' in error && error.code === wsMessageTooLong ? undefined : 'fatal';
}

function milliseconds(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!(Number.isFinite(value) && value >= 0)) throw new RangeError(name + ' must be a finite number of 0 or more');
  return value;
}

function closed(): MqttError {
  return new MqttError('ERR_MQTT_CLOSING', 'Client disconnected');
}

interface Waiter {
  readonly promise: Promise<ClientSession>;
  readonly resolve: (session: Readonly<ClientSession>) => void;
  readonly reject: (reason: Readonly<Error>) => void;
}

function waiter(): Waiter {
  let resolve: (session: Readonly<ClientSession>) => void = () => {};
  let reject: (reason: Readonly<Error>) => void = () => {};
  const promise = new Promise<ClientSession>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  // A caller that never asks for this session must not see an unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/**
 * Keep a connection to the broker. `create` builds a fresh one-shot factory for each attempt, such as
 * `(options) => createTcpClient(options)`. After a CONNACK with Session Present false, the client makes `subscriptions`
 * again. A QoS 1 or QoS 2 publication that was in flight when a session ended is reported in the next `connected` event.
 * Without `resume`, the client never sends it again. With `resume`, a session the broker resumed continues its exchange
 * with its Packet Identifier. Throws a RangeError at once when an option in `reconnect` is invalid, or when `resume` is set and
 * `options` has no `sessionExpiryInterval` from 1 to 4,294,967,295.
 */
export function createReconnectingClient<Options extends Reconnectable>(
  create: (options: Options) => ClientFactory,
  options: Options,
  reconnect: Readonly<ReconnectOptions> = {},
): ReconnectingClient {
  const initialDelayMs = milliseconds(reconnect.initialDelayMs, 1000, 'initialDelayMs');
  const maxDelayMs = Math.max(initialDelayMs, milliseconds(reconnect.maxDelayMs, 30_000, 'maxDelayMs'));
  const maxAttempts = reconnect.maxAttempts ?? 10;
  if (!(maxAttempts >= 0)) throw new RangeError('maxAttempts must be a number of 0 or more');
  const stableAfterMs = milliseconds(reconnect.stableAfterMs, maxDelayMs, 'stableAfterMs');
  const random = reconnect.random ?? Math.random;
  const intents = [...(reconnect.subscriptions ?? [])];
  for (const intent of intents) {
    const { topic, qos }: Readonly<Partial<Record<'topic' | 'qos', unknown>>> = intent;
    if (typeof topic !== 'string' || !validateTopic(topic)) throw new RangeError('Invalid MQTT subscription topic filter');
    if (qos !== undefined && qos !== 0 && qos !== 1 && qos !== 2) throw new RangeError('Invalid MQTT subscription QoS');
  }
  const { onReconnect } = reconnect;
  const userSignal = options.signal;
  const userEnd = options.onSessionEnd;
  const resume = reconnect.resume === true;
  if (resume && !isSessionExpiryInterval(options.sessionExpiryInterval, 1))
    throw new RangeError('resume needs a sessionExpiryInterval from 1 to 4294967295');

  let state: 'connecting' | 'connected' | 'waiting' | 'stopped' = 'connecting';
  // The number of sessions reported in a connected event.
  let generation = 0;
  // The number of attempts since the last stable session.
  let attempt = 0;
  let next = waiter();
  let current: Readonly<ClientSession> | undefined;
  let connectedAt = 0;
  let previous: SessionEnd | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopError: Readonly<Error> | undefined;
  let opening: AbortController | undefined;
  let cleanStart = options.cleanStart;
  let resetRequested = false;
  let dropped: UncertainPublication[] = [];
  // PUBACK events of a resumed session, held until its connected event or its end.
  let held: ReconnectEvent[] | undefined;

  // A function, so a check after an await reads the state instead of the type narrowed before it.
  const stopped = (): boolean => state === 'stopped';

  const report = (event: ReconnectEvent): void => {
    if (onReconnect !== undefined) void notifyObserver(onReconnect, event);
  };

  const release = (): void => {
    const events = held;
    held = undefined;
    for (const event of events ?? []) report(event);
  };

  const shared = resume
    ? bindSessionState({
        resent(kind, topic, messageId, reasonCode) {
          const event: ReconnectEvent = { kind, topic, messageId, reasonCode };
          if (held === undefined) report(event);
          else held.push(event);
        },
      })
    : undefined;

  const stop = (reason: StopReason, error: Readonly<Error>): void => {
    if (stopped()) return;
    state = 'stopped';
    stopError = error;
    clearTimeout(timer);
    timer = undefined;
    userSignal?.removeEventListener('abort', onUserAbort);
    opening?.abort(error);
    next.reject(error);
    release();
    report(reason === 'disconnect' ? { kind: 'stopped', reason } : { kind: 'stopped', reason, error });
  };

  function onUserAbort(): void {
    const reason: unknown = userSignal?.reason;
    stop(
      'aborted',
      reason instanceof Error
        ? reason
        : Object.assign(new MqttError('ERR_MQTT_ABORTED', 'MQTT reconnect aborted', { cause: reason }), { name: 'AbortError' }),
    );
  }

  const ended = (event: SessionEnd): void => {
    if (stopped()) {
      current = undefined;
      return;
    }
    if (current !== undefined && performance.now() - connectedAt >= stableAfterMs) attempt = 0;
    current = undefined;
    release();
    if (state === 'connected') previous = event;
    if (event.kind === 'disconnect') {
      stop('disconnect', closed());
      return;
    }
    if (userSignal?.aborted === true) return;
    const { error } = event;
    const reason = stopReason(error);
    if (reason !== undefined) {
      stop(reason, error);
      return;
    }
    if (attempt >= maxAttempts) {
      stop('exhausted', error);
      return;
    }
    if (state === 'connected') next = waiter();
    state = 'waiting';
    const ceiling = Math.min(maxDelayMs, initialDelayMs * 2 ** Math.max(0, attempt - 1));
    const delayMs = ceiling / 2 + random() * (ceiling / 2);
    timer = setTimeout(open, delayMs);
    report({ kind: 'retrying', attempt: attempt + 1, delayMs, error });
  };

  const restore = async (session: Readonly<ClientSession>): Promise<SubscriptionRestore[]> => {
    const results: SubscriptionRestore[] = [];
    for (const { topic, qos = 0 } of intents) {
      try {
        results.push({ topic, qos, result: await session.subscribe(topic, { qos }) });
      } catch (error) {
        // A fatal MqttError, or an error of another class such as a failed SUBSCRIBE write, ended the session, and
        // onSessionEnd schedules the next attempt.
        if (!(error instanceof MqttError) || error.fatal) throw error;
        results.push({ topic, qos, error });
      }
    }
    return results;
  };

  function open(): void {
    timer = undefined;
    if (stopped()) return;
    state = 'connecting';
    attempt++;
    const thisAttempt = { ended: false };
    const end = (event: SessionEnd): void => {
      if (thisAttempt.ended) return;
      thisAttempt.ended = true;
      ended(event);
    };
    const superseded = (): boolean => thisAttempt.ended || stopped();
    opening = new AbortController();
    const signal = userSignal === undefined ? opening.signal : AbortSignal.any([userSignal, opening.signal]);
    const onSessionEnd: SessionEndObserver = async (event) => {
      end(event);
      await userEnd?.(event);
    };
    let stored: readonly UncertainPublication[] = [];
    let attemptOptions: Options = { ...options, onSessionEnd, signal };
    if (shared !== undefined) {
      if (resetRequested) {
        resetRequested = false;
        dropped.push(...shared.drop());
        cleanStart = true;
      }
      stored = shared.state.inFlight;
      held = [];
      attemptOptions = { ...attemptOptions, cleanStart, sessionState: shared.state };
    }
    let factory: ClientFactory;
    try {
      factory = create(attemptOptions);
    } catch (error) {
      stop('fatal', transportFailure(error, 'MQTT client factory failed'));
      return;
    }
    void (async () => {
      let session: Readonly<ClientSession>;
      try {
        session = await factory.connect();
      } catch (error) {
        end({ kind: 'error', error: transportFailure(error, 'MQTT connection failed') });
        return;
      }
      if (superseded()) return;
      opening = undefined;
      current = session;
      connectedAt = performance.now();
      const resumed = session.connection.sessionPresent;
      if (shared !== undefined) {
        cleanStart = false;
        if (!resumed) dropped.push(...stored);
      }
      let subscriptions: SubscriptionRestore[] = [];
      try {
        if (!resumed) subscriptions = await restore(session);
      } catch {
        return;
      }
      if (superseded()) return;
      state = 'connected';
      generation++;
      next.resolve(session);
      const lost = dropped;
      dropped = [];
      report({
        kind: 'connected',
        generation,
        attempt,
        session,
        subscriptions,
        resumed,
        ...(previous === undefined ? {} : { previous }),
        ...(resumed && stored.length > 0 ? { resent: stored } : {}),
        ...(lost.length > 0 ? { dropped: lost } : {}),
      });
      release();
    })();
  }

  userSignal?.addEventListener('abort', onUserAbort, { once: true });
  // The first attempt starts after this function returns, so an onReconnect that refers to the returned client can run.
  queueMicrotask(() => {
    if (userSignal?.aborted === true) onUserAbort();
    else open();
  });

  return {
    // oxlint-disable-next-line typescript/promise-function-async -- Removing it would cost developer experience. `session` returns the one stored promise until that session ends, and the test 'returns the same session promise until that session ends' in test/reconnect.test.ts compares the promises with `toBe`. An async method would return a new promise on each call.
    session() {
      return stopError === undefined ? next.promise : Promise.reject(stopError);
    },
    retryNow() {
      if (state !== 'waiting') return false;
      clearTimeout(timer);
      open();
      return true;
    },
    async disconnect(disconnectOptions) {
      const session = current;
      stop('disconnect', closed());
      if (session !== undefined) await session.disconnect(disconnectOptions);
    },
    resetSession() {
      if (shared !== undefined) resetRequested = true;
    },
  };
}
