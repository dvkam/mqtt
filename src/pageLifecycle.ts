import { notifyObserver } from './diagnostics.js';
import { MqttError } from './mqttError.js';
import type { ReconnectingClient } from './reconnect.js';
import type { ClientSession } from './session.js';

/** What `onReturn` receives once the adapter has checked the connection after the page came back. */
export interface PageReturn {
  /**
   * The event that showed the page came back: `pageshow` with `persisted` true after a restore from the back-forward
   * cache, `resume` after a freeze, or `visibilitychange` when a hidden page became visible.
   */
  readonly trigger: 'pageshow' | 'resume' | 'visibilitychange';
  /**
   * Milliseconds of `performance.now()` since the page went away with a `visibilitychange` to hidden, a `freeze` or a
   * `pagehide`. The monotonic clock can leave out time the device slept.
   */
  readonly awayMs: number;
  /**
   * `retried` when the client was waiting for its retry timer and started an attempt at once, also after a failed ping
   * ended the session. `answered` when the session answered a ping. `ended` when the ping failed and the client did not
   * start an attempt, because it stopped or another attempt was already open. `stopped` when the client had stopped
   * before the check. `skipped` when a ping from an earlier return was still pending, or when a ping rejected without
   * ending the session, as it does while another ping waits for its PINGRESP.
   */
  readonly outcome: 'retried' | 'answered' | 'ended' | 'stopped' | 'skipped';
}

/** The options of `watchPageLifecycle`. */
export interface PageLifecycleOptions {
  /** Receives one event for each return of the page, after its check settled. A thrown error or a rejection is ignored. */
  readonly onReturn?: (event: PageReturn) => void | Promise<void>;
}

type Outcome = PageReturn['outcome'];

/**
 * Check a reconnecting client each time the page comes back after it was hidden, frozen or kept in the back-forward
 * cache. When the client waits for its retry timer, the adapter calls `retryNow()`. When a session is connected, or once
 * the attempt that is open connects, the adapter sends one ping, which the client's `timeoutMs` bounds. A failed ping ends
 * the session, and the adapter then calls `retryNow()` so the next attempt does not wait for the backoff. The adapter never
 * disconnects. It listens for `pagehide` and `pageshow` on `window`, and for `freeze`, `resume` and `visibilitychange` on
 * `document`. Without both objects, as in a server render, it listens for nothing. Returns a function that removes the
 * listeners and stops `onReturn`.
 */
export function watchPageLifecycle(client: Readonly<ReconnectingClient>, options: Readonly<PageLifecycleOptions> = {}): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const { onReturn } = options;
  const page = window;
  const view = document;
  let awaySince: number | undefined;
  let pinging = false;
  let watching = true;

  const ping = async (): Promise<Outcome> => {
    let session: ClientSession;
    try {
      session = await client.session();
    } catch {
      return 'stopped';
    }
    try {
      await session.ping();
      return 'answered';
    } catch (error) {
      if (error instanceof MqttError && !error.fatal) return 'skipped';
      return client.retryNow() ? 'retried' : 'ended';
    }
  };

  const check = async (): Promise<Outcome> => {
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
    if (awaySince === undefined) return;
    const now = performance.now();
    const awayMs = now - awaySince;
    awaySince = view.visibilityState === 'hidden' ? now : undefined;
    void check().then(async (outcome) => {
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
