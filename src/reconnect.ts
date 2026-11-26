import { notifyObserver } from './diagnostics.js';
import { MqttError, type MqttErrorCode } from './mqttError.js';
import type {
  ClientFactory,
  ClientSession,
  DisconnectOptions,
  SessionEnd,
  SessionEndObserver,
  SubscribeResult,
} from './session.js';

/** The factory options a reconnecting client sets for each attempt. */
export interface Reconnectable {
  onSessionEnd?: SessionEndObserver;
  signal?: AbortSignal;
}

/** A subscription the reconnecting client makes on every connection, in the order given. */
export interface SubscriptionIntent {
  readonly topic: string;
  readonly qos?: 0 | 1;
}

/** The outcome of one subscription when a connection starts. A refused SUBACK keeps the session. */
export type SubscriptionRestore = Readonly<{ topic: string; qos: 0 | 1 } & ({ result: SubscribeResult } | { error: unknown })>;

export type ReconnectEvent =
  | Readonly<{
      kind: 'connected';
      /** Counts connected sessions, starting at 1. */
      generation: number;
      /** Counts attempts since the last stable session, starting at 1. */
      attempt: number;
      session: Readonly<ClientSession>;
      /** How the previous session ended, including the QoS 1 publications whose outcome is unknown. */
      previous?: SessionEnd;
      subscriptions: readonly SubscriptionRestore[];
    }>
  | Readonly<{ kind: 'retrying'; attempt: number; delayMs: number; error: unknown }>
  | Readonly<{ kind: 'stopped'; reason: 'disconnect' | 'aborted' | 'refused' | 'fatal' | 'exhausted'; error?: unknown }>;

export interface ReconnectOptions {
  /** Subscriptions to make after every CONNACK. */
  readonly subscriptions?: readonly SubscriptionIntent[];
  /** The delay before the second attempt, in milliseconds. Defaults to 1,000. */
  readonly initialDelayMs?: number;
  /** The longest delay between attempts, in milliseconds. Defaults to 30,000. */
  readonly maxDelayMs?: number;
  /** Consecutive failed attempts before the client stops. Defaults to 10. */
  readonly maxAttempts?: number;
  /** A session that stays up this long, in milliseconds, resets the attempt count. Defaults to `maxDelayMs`. */
  readonly stableAfterMs?: number;
  /** A source of numbers in [0, 1) for the jitter. Defaults to Math.random. */
  readonly random?: () => number;
  readonly onReconnect?: (event: ReconnectEvent) => void | Promise<void>;
}

export interface ReconnectingClient {
  /** The current session, or the next one once it connects and its subscriptions are made. Rejects after the client stops. */
  session(): Promise<ClientSession>;
  /** Stops reconnecting, then disconnects the current session. */
  disconnect(options?: Readonly<DisconnectOptions>): Promise<void>;
}

// MQTT 5 CONNACK reasons worth another attempt: Server unavailable, Server busy, Quota exceeded, Connection rate exceeded.
const retryRefusals: ReadonlySet<number | undefined> = new Set([0x88, 0x89, 0x97, 0x9f]);
// Broker DISCONNECT reasons that stop: Malformed Packet, Protocol Error, Not authorized, Session taken over, Use another
// server and Server moved.
const stopDisconnects: ReadonlySet<number | undefined> = new Set([0x81, 0x82, 0x87, 0x8e, 0x9c, 0x9d]);

// Codes that end a session but not the broker's willingness to accept another. Every other code stops the client.
const retryCodes: ReadonlySet<MqttErrorCode> = new Set(['ERR_MQTT_TRANSPORT', 'ERR_MQTT_TIMEOUT']);

function stopReason(error: unknown): 'refused' | 'fatal' | undefined {
  if (!(error instanceof MqttError)) return error instanceof RangeError ? 'fatal' : undefined;
  if (error.code === 'ERR_MQTT_REFUSED') return retryRefusals.has(error.reasonCode) ? undefined : 'refused';
  if (error.code === 'ERR_MQTT_BROKER_DISCONNECT') return stopDisconnects.has(error.reasonCode) ? 'fatal' : undefined;
  return retryCodes.has(error.code) ? undefined : 'fatal';
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!(value >= 0) || value === Number.POSITIVE_INFINITY) throw new RangeError(name + ' must be a finite number of 0 or more');
  return value;
}

interface Waiter {
  readonly promise: Promise<ClientSession>;
  readonly resolve: (session: Readonly<ClientSession>) => void;
  readonly reject: (reason: unknown) => void;
}

function waiter(): Waiter {
  let resolve: (session: Readonly<ClientSession>) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
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
 * `(options) => createTcpClient(options)`. Each attempt opens a clean session, so the client makes `subscriptions` again
 * after every CONNACK. A QoS 1 publication that was in flight when a session ended is reported in the next `connected`
 * event and never sent again.
 */
export function createReconnectingClient<Options extends Reconnectable>(
  create: (options: Options) => ClientFactory,
  options: Options,
  reconnect: Readonly<ReconnectOptions> = {},
): ReconnectingClient {
  const initialDelayMs = positive(reconnect.initialDelayMs, 1000, 'initialDelayMs');
  const maxDelayMs = Math.max(initialDelayMs, positive(reconnect.maxDelayMs, 30_000, 'maxDelayMs'));
  const maxAttempts = positive(reconnect.maxAttempts, 10, 'maxAttempts');
  const stableAfterMs = positive(reconnect.stableAfterMs, maxDelayMs, 'stableAfterMs');
  const random = reconnect.random ?? Math.random;
  const intents = [...(reconnect.subscriptions ?? [])];
  const { onReconnect } = reconnect;
  const userSignal = options.signal;
  const userEnd = options.onSessionEnd;

  let state: 'connecting' | 'connected' | 'waiting' | 'stopped' = 'connecting';
  let generation = 0;
  let attempt = 0;
  let next = waiter();
  let current: Readonly<ClientSession> | undefined;
  let connectedAt = 0;
  let previous: SessionEnd | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopError: Readonly<Error> = new MqttError('ERR_MQTT_CLOSING', 'Client disconnected');
  // Aborts the attempt that is opening when the client stops.
  let opening: AbortController | undefined;

  // A function, so a check after an await reads the state instead of the type narrowed before it.
  const stopped = (): boolean => state === 'stopped';

  const report = (event: ReconnectEvent): void => {
    if (onReconnect !== undefined) void notifyObserver(onReconnect, event);
  };

  const stop = (reason: 'disconnect' | 'aborted' | 'refused' | 'fatal' | 'exhausted', error: unknown): void => {
    if (state === 'stopped') return;
    state = 'stopped';
    stopError = error instanceof Error ? error : new MqttError('ERR_MQTT_ABORTED', 'MQTT reconnect aborted', { cause: error });
    clearTimeout(timer);
    timer = undefined;
    userSignal?.removeEventListener('abort', onUserAbort);
    opening?.abort(stopError);
    next.reject(stopError);
    report(reason === 'disconnect' ? { kind: 'stopped', reason } : { kind: 'stopped', reason, error });
  };

  function onUserAbort(): void {
    const reason: unknown = userSignal?.reason;
    stop('aborted', reason);
  }

  // A failed opening can report both through onSessionEnd and through the connect() rejection, so each generation ends once.
  const ended = (owner: number, event: SessionEnd): void => {
    if (owner !== generation || state === 'stopped' || state === 'waiting') return;
    if (current !== undefined && performance.now() - connectedAt >= stableAfterMs) attempt = 0;
    current = undefined;
    previous = event;
    if (event.kind === 'disconnect') {
      stop('disconnect', new MqttError('ERR_MQTT_CLOSING', 'Client disconnected'));
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
    report({ kind: 'retrying', attempt: attempt + 1, delayMs, error });
    timer = setTimeout(open, delayMs);
  };

  const restore = async (session: Readonly<ClientSession>): Promise<SubscriptionRestore[]> => {
    const results: SubscriptionRestore[] = [];
    for (const { topic, qos = 0 } of intents) {
      try {
        results.push({ topic, qos, result: await session.subscribe(topic, { qos }) });
      } catch (error) {
        results.push({ topic, qos, error });
        // A fatal rejection ended the session, and onSessionEnd schedules the next attempt.
        if (!(error instanceof MqttError) || error.fatal) throw error;
      }
    }
    return results;
  };

  function open(): void {
    timer = undefined;
    if (state === 'stopped') return;
    state = 'connecting';
    attempt++;
    const owner = ++generation;
    opening = new AbortController();
    const signal = userSignal === undefined ? opening.signal : AbortSignal.any([userSignal, opening.signal]);
    const onSessionEnd: SessionEndObserver = async (event) => {
      ended(owner, event);
      await userEnd?.(event);
    };
    let factory: ClientFactory;
    try {
      factory = create({ ...options, onSessionEnd, signal });
    } catch (error) {
      stop('fatal', error);
      return;
    }
    void (async () => {
      let session: Readonly<ClientSession>;
      try {
        session = await factory.connect();
      } catch (error) {
        ended(owner, {
          kind: 'error',
          error: error instanceof Error ? error : new MqttError('ERR_MQTT_TRANSPORT', 'MQTT connection failed', { cause: error }),
        });
        return;
      }
      if (owner !== generation || stopped()) return;
      opening = undefined;
      current = session;
      connectedAt = performance.now();
      let subscriptions: SubscriptionRestore[];
      try {
        subscriptions = await restore(session);
      } catch {
        return;
      }
      if (owner !== generation || stopped() || current !== session) return;
      state = 'connected';
      const event: ReconnectEvent = {
        kind: 'connected',
        generation: owner,
        attempt,
        session,
        subscriptions,
        ...(previous === undefined ? {} : { previous }),
      };
      next.resolve(session);
      report(event);
    })();
  }

  userSignal?.addEventListener('abort', onUserAbort, { once: true });
  if (userSignal?.aborted === true) stop('aborted', userSignal.reason);
  else open();

  return {
    // oxlint-disable-next-line typescript/promise-function-async -- An async function would wrap the promise, and repeated calls in one generation must return the same promise.
    session() {
      return stopped() ? Promise.reject(stopError) : next.promise;
    },
    async disconnect(disconnectOptions) {
      const session = current;
      stop('disconnect', new MqttError('ERR_MQTT_CLOSING', 'Client disconnected'));
      if (session !== undefined) await session.disconnect(disconnectOptions);
    },
  };
}
