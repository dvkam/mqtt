# Page lifecycle in the browser

A browser can hide a page, freeze it or keep it in the back-forward cache. While the page is away, its timers run late or not at all, and its WebSocket can close or stop answering. The clients listen for no page event. `watchPageLifecycle` from `mqtt/browser` is an optional adapter that checks a [reconnecting client](reconnect.md) each time the page comes back. The other entries do not export it, and a bundle that does not import it does not contain it.

```ts
import { createBrowserClient, createReconnectingClient, watchPageLifecycle } from 'mqtt/browser';

const client = createReconnectingClient(createBrowserClient, { url: 'wss://broker.example/mqtt', clientId: 'dashboard-7' });
const stopWatching = watchPageLifecycle(client, {
  onReturn(event) {
    console.log(event.trigger, event.outcome, event.awayMs);
  },
});
```

## What it does

The page is away from a `visibilitychange` to `hidden`, a `freeze` or a `pagehide`. It comes back with a `pageshow` whose `persisted` is true, a `resume`, or a `visibilitychange` to `visible`. The adapter listens for `pagehide` and `pageshow` on `window` and for the other three on `document`. A page that is hidden when the adapter starts counts as away. A `pageshow` with `persisted` false is the first load, and the adapter ignores it.

On each return the adapter runs one check:

1. When the client waits for its retry timer, the adapter calls `client.retryNow()`, which clears the timer and starts the next attempt at once. A timer of a hidden page can run minutes late, so the attempt does not wait for it.
2. Otherwise it sends one ping on the session from `client.session()`. While an attempt opens, that ping waits for the session. The client's `timeoutMs`, 3,000 milliseconds by default, bounds the ping. A session that answers stays. A ping that fails ends the session, as every failed ping does, and the adapter calls `retryNow()` so the next attempt does not wait for the backoff.

So a session that stopped answering while the page was away ends at most `timeoutMs` after the return. Until then `session()` still returns it. Every publish, subscribe and ping keeps its own `timeoutMs` deadline. A frozen page runs no timer, and its overdue timers run once it resumes, so an operation that was pending through a freeze rejects with `ERR_MQTT_TIMEOUT` when the page runs again.

One return often fires several events. The first event that ends the absence runs the check. When the page is still hidden after it, as after the `resume` that Chromium fires before a restored page becomes visible, the page stays away, and the next return runs another check. While a ping from an earlier check is pending, a new check sends no second ping. `retryNow()` starts no attempt while one is open, so the checks never start a second attempt or a second timer.

`onReturn` receives one event per check once it has settled. `trigger` names the event, and `awayMs` holds the milliseconds of `performance.now()` since the page went away. The monotonic clock can leave out time the device slept. `outcome` is `retried` when the check started an attempt, `answered` when the session answered the ping, `ended` when the ping failed and no attempt started, `stopped` when the client had stopped, and `skipped` when a ping was already pending or a ping rejected without ending the session. A thrown error or a rejection from `onReturn` is ignored.

The adapter never disconnects. The function it returns removes the five listeners and stops `onReturn`, also for a check that is still running. Without `window` and `document`, as in a server render, the adapter listens for nothing and returns a function that does nothing.

## Pages in the back-forward cache

On a `pagehide` with `persisted` true, the adapter leaves the connection open. A reconnecting client cannot connect again after a disconnect, so a disconnect on `pagehide` would leave nothing to restore. Chromium keeps such a page in the back-forward cache with its WebSocket. When the page is restored, the WebSocket fails, the session ends, and the adapter starts the next attempt at once. The broker counts the client as connected until then, because the client sends Keep Alive 0. The connection then ends without DISCONNECT, so the broker publishes the Will if one is set.

An application that must send DISCONNECT before the page enters the cache disconnects the client in its own `pagehide` handler, then creates a new reconnecting client and a new adapter in its `pageshow` handler.

## What was checked in a browser

`test/packed/page-lifecycle.ts` drives the packed adapter in Chromium against Mosquitto over WebSocket, through a TCP proxy that counts connections and can make them stop answering. The scheduled CI job runs it after it installs the browsers. These results are from Chromium 158.0.8127.36 with Playwright 1.65.1 in new headless mode:

- A navigation to another page and `page.goBack()` restore the page from the back-forward cache. Chromium sends no `Page.backForwardCacheNotUsed` event. Leaving fires `pagehide` with `persisted` true, `visibilitychange` to hidden and `freeze`. The restore fires `resume` while the page is still hidden, then `visibilitychange` to visible and `pageshow` with `persisted` true.
- The proxy still holds the TCP connection of the cached page 2 seconds after the navigation. After the restore, the WebSocket fires `error`, the session ends with `ERR_MQTT_TRANSPORT`, and the next session connects at once although the backoff drew 10 to 20 seconds.
- A connection that stops answering while the page is hidden ends at the ping deadline after the return, and the next session connects about 1,100 milliseconds after the return with a `timeoutMs` of 1,000.
- A QoS 1 publication on a connection that stops answering rejects with `ERR_MQTT_TIMEOUT` after 1,000 milliseconds while the page is hidden. The return then starts the next attempt at once, and its `connected` event lists the publication as uncertain.
- Across these steps, the page opens four connections, one per session.

Playwright starts Chromium with `--disable-back-forward-cache`, so the check removes that switch. The headless shell, Playwright's default Chromium, still refuses the cache with the reasons `BackForwardCacheDisabledForDelegate` and `BrowsingInstanceNotSwapped`, so the check launches the `chromium` channel. A headless page stays visible, so the steps after the restore dispatch `visibilitychange` with a replaced `document.visibilityState` getter. On a visible headless page, the DevTools command `Page.setWebLifecycleState` with `frozen` fired no `freeze` event. The only real freeze in the check is the one the back-forward cache causes.

`test/page-lifecycle.test.ts` covers the adapter with fake timers and event targets in Node: a long scheduling pause, hidden to visible, `pageshow` with `persisted` true, freeze and resume, repeated events, a stopped client and the stop function. `test/reconnect.test.ts` covers `retryNow()`.

## Gaps

These need a real browser lifecycle test that has not run:

- Firefox and WebKit. CI's scheduled job installs both, but the check runs in Chromium only, and they could not be installed where this was written because their download host was blocked. Each needs a check of back-forward cache eligibility with an open WebSocket, whether the socket closes on entry or on restore, and the order of `pagehide`, `pageshow` and `visibilitychange`. The adapter does not need `freeze` and `resume`, but this was not checked in a browser without them.
- Timer throttling in a hidden tab. Playwright passes `--disable-background-timer-throttling`, so no check delays the retry timer the way a hidden tab does.
- A freeze outside the back-forward cache, such as Chromium freezing a background tab, and a discarded tab, which reloads instead of resuming.
- A device that sleeps while the page stays visible. No page event fires, so the adapter does not check. Until the browser closes the socket, a session that stopped answering ends only when an operation passes its deadline.
- Mobile browsers, which can hide and freeze a page more often than desktop ones.
