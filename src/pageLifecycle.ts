import { notifyObserver } from './diagnostics.js';
import { MqttError } from './mqttError.js';
import type { ReconnectingClient } from './reconnect.js';
import type { ClientSession } from './session.js';

/** What `onReturn` receives once the adapter has checked the connection after the page came back. */
export interface PageReturn {
  /**
   * The event that ended the absence: `pageshow` with `persisted` true, `resume`, or `visibilitychange`. Only an event
   * that finds the page visible ends it. Chromium fires `resume` while a restored page is still hidden, so a restore from
   * the back-forward cache there reports `visibilitychange`.
   */
  readonly trigger: 'pageshow' | 'resume' | 'visibilitychange';
  /**
   * Milliseconds of `performance.now()` from the first `visibilitychange` to hidden, `freeze` or `pagehide` of the
   * absence, or from the start of the adapter on a hidden page, to the event in `trigger`. The monotonic clock can leave
   * out time the device slept.
   */
  readonly awayMs: number;
  /**
   * `retried` when the check started an attempt at once: the client was waiting for its retry timer, or a failed ping
   * ended the session. `answered` when the session answered a ping. `ended` when the ping failed and no attempt started,
   * because the client stopped or an attempt was already open. `connecting` when an attempt was open, so the adapter
   * sent no ping. `stopped` when the client had stopped, which includes a client that stopped with `exhausted` or
   * `fatal` while it waited. `skipped` when the absence was shorter than `checkAfterMs`, when a ping from an earlier check
   * was still pending, or when the ping rejected with `ERR_MQTT_CAPACITY` because a ping from the application waits for
   * its PINGRESP.
   */
  readonly outcome: 'retried' | 'answered' | 'ended' | 'connecting' | 'stopped' | 'skipped';
}

/** The options of `watchPageLifecycle`. */
export interface PageLifecycleOptions {
  /**
   * The shortest absence, in milliseconds of `performance.now()`, after which a return runs a check. A shorter one
   * reports `skipped`. A finite number of 0 or more. Defaults to 0, so every return runs a check.
   */
  readonly checkAfterMs?: number;
  /** Receives one event for each return, once its check settled. A thrown error or a rejection is ignored. */
  readonly onReturn?: (event: PageReturn) => void | Promise<void>;
}

type Outcome = PageReturn['outcome'];

/**
 * Check a reconnecting client each time the page comes back after it was hidden, frozen or kept in the back-forward
 * cache. The page goes away on a `visibilitychange` to hidden, a `freeze` or a `pagehide`, and a page that is hidden when
 * the adapter starts counts as away. It comes back on the first `pageshow` with `persisted` true, `resume` or
 * `visibilitychange` that finds it visible. A `pageshow` with `persisted` false is ignored. On a return, the adapter calls
 * `retryNow()` when the client waits for its retry timer. When a session is connected, it sends one ping, which the
 * session's `timeoutMs` bounds, and calls `retryNow()` after a ping that ended the session. While an attempt opens, it
 * does nothing. The adapter never disconnects. It listens on `window` and `document`, and without them, as in a server
 * render, it listens for nothing. It needs a client from `createReconnectingClient`, whose `session()` returns an already
 * fulfilled promise while a session is connected. Throws a RangeError at once for an invalid `checkAfterMs`. Returns a function that
 * removes the listeners and stops `onReturn`.
 */
export function watchPageLifecycle(client: Readonly<ReconnectingClient>, options: Readonly<PageLifecycleOptions> = {}): () => void {
  const { checkAfterMs = 0, onReturn } = options;
  if (!(Number.isFinite(checkAfterMs) && checkAfterMs >= 0))
    throw new RangeError('checkAfterMs must be a finite number of 0 or more');
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const page = window;
  const view = document;
  let awaySince: number | undefined;
  let pinging = false;
  let watching = true;

  const ping = async (): Promise<Outcome> => {
    let session: ClientSession | undefined;
    try {
      // Promise.race settles with the first promise in the list that has already settled, so it yields undefined only
      // while session() is pending.
      session = await Promise.race([client.session(), Promise.resolve(undefined)]);
    } catch {
      return 'stopped';
    }
    if (session === undefined) return 'connecting';
    try {
      await session.ping();
      return 'answered';
    } catch (error) {
      if (error instanceof MqttError && !error.fatal) return 'skipped';
      return client.retryNow() ? 'retried' : 'ended';
    }
  };

  const check = async (awayMs: number): Promise<Outcome> => {
    if (awayMs < checkAfterMs) return 'skipped';
    if (client.retryNow()) return 'retried';
    if (pinging) return 'skipped';
    pinging = true;
    try {
      return await ping();
    } finally {
      pinging = false;
    }
  };

  const away = (): void => {
    awaySince ??= performance.now();
  };

  const returned = (trigger: PageReturn['trigger']): void => {
    if (awaySince === undefined || view.visibilityState === 'hidden') return;
    const awayMs = performance.now() - awaySince;
    awaySince = undefined;
    void check(awayMs).then(async (outcome) => {
      if (watching && onReturn !== undefined) await notifyObserver(onReturn, { trigger, awayMs, outcome });
    });
  };

  const onPageShow = (event: Readonly<{ persisted: boolean }>): void => {
    if (event.persisted) returned('pageshow');
  };
  const onResume = (): void => {
    returned('resume');
  };
  const onVisibility = (): void => {
    if (view.visibilityState === 'hidden') away();
    else returned('visibilitychange');
  };

  page.addEventListener('pagehide', away);
  page.addEventListener('pageshow', onPageShow);
  view.addEventListener('freeze', away);
  view.addEventListener('resume', onResume);
  view.addEventListener('visibilitychange', onVisibility);
  if (view.visibilityState === 'hidden') away();
  return () => {
    watching = false;
    page.removeEventListener('pagehide', away);
    page.removeEventListener('pageshow', onPageShow);
    view.removeEventListener('freeze', away);
    view.removeEventListener('resume', onResume);
    view.removeEventListener('visibilitychange', onVisibility);
  };
}
