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

The page goes away on a `visibilitychange` to `hidden`, a `freeze` or a `pagehide`. It comes back on the first `pageshow` with `persisted` true, `resume` or `visibilitychange` that finds it visible. An event that finds the page still hidden, such as the `resume` that Chromium fires before a restored page becomes visible, does not end the absence. The adapter listens for `pagehide` and `pageshow` on `window` and for the other three on `document`. A page that is hidden when the adapter starts counts as away. A `pageshow` with `persisted` false is the first load, and the adapter ignores it.

Each return runs one check:

1. When the absence was shorter than `checkAfterMs`, the check does nothing. `checkAfterMs` defaults to 0, so every return runs the steps below.
2. When the client waits for its retry timer, the adapter calls `client.retryNow()`, which clears the timer and starts the next attempt at once. A timer of a hidden page can run minutes late, so the attempt does not wait for it.
3. While an attempt opens, the adapter does nothing more. The attempt has its own `timeoutMs` deadline.
4. When a session is connected, the adapter sends one ping on it. The client's `timeoutMs`, 3,000 milliseconds by default, bounds the ping. A session that answers stays. A ping that fails ends the session, as every failed ping does, and the adapter calls `retryNow()` so the next attempt does not wait for the backoff.

So a session that stopped answering while the page was away ends at most `timeoutMs` after the return. Until then `session()` still returns it. Every publish, subscribe and ping keeps its own `timeoutMs` deadline. A frozen page runs no timer, and its overdue timers run once it resumes, so an operation that was pending through a freeze rejects with `ERR_MQTT_TIMEOUT` as soon as the page runs again.

While a ping from an earlier check is pending, a new check sends no second ping. `retryNow()` starts no attempt while one is open, so the checks never start a second attempt or a second timer.

`onReturn` receives one event for each return once its check settled, which takes at most `timeoutMs`. `trigger` names the event that ended the absence. `awayMs` holds the milliseconds of `performance.now()` from the first event of the absence to that event. The monotonic clock can leave out time the device slept. `outcome` is one of these:

| Outcome | Meaning |
| --- | --- |
| `retried` | The check started an attempt, because the client was waiting or because a failed ping ended the session |
| `answered` | The session answered the ping |
| `ended` | The ping failed and no attempt started, because the client stopped or an attempt was already open |
| `connecting` | An attempt was open, so the adapter sent no ping |
| `stopped` | The client had stopped, also when it stopped with `exhausted` or `fatal` while the page was away |
| `skipped` | The absence was shorter than `checkAfterMs`, a ping from an earlier check was pending, or the ping rejected with `ERR_MQTT_CAPACITY` because a ping from the application waits for its PINGRESP |

A thrown error or a rejection from `onReturn` is ignored. An invalid `checkAfterMs` throws a `RangeError` from `watchPageLifecycle`.

The adapter never disconnects. The function it returns removes the five listeners and stops `onReturn`, also for a check that is still running. Without `window` and `document`, as in a server render, the adapter listens for nothing and returns a function that does nothing.

## What a check costs

A ping can end a session that is healthy but slow. When the network wakes slower than `timeoutMs`, as a mobile radio can, the ping times out and the session ends without DISCONNECT. The broker then publishes the Will if one is set, and each QoS 1 publication in flight becomes uncertain. Any publish or subscribe the application sent at that moment would end the session the same way. A check can also start an attempt early, and that attempt counts toward `maxAttempts`, so a page that switches tabs every few seconds while the broker is down uses up its attempts faster. Raise `checkAfterMs` to skip the check after short absences. The adapter cannot give the ping a longer deadline than `timeoutMs`, because only the session can end itself and its ping deadline is `timeoutMs`. The default of 0 keeps every return checked, because `awayMs` can leave out a sleep of the device.

## Pages in the back-forward cache

On a `pagehide` with `persisted` true, the adapter leaves the connection open. A reconnecting client cannot connect again after a disconnect, so a disconnect on `pagehide` would leave nothing to restore. Chromium keeps such a page in the back-forward cache with its WebSocket. When the page is restored, the WebSocket fails, the session ends, and the adapter starts the next attempt at once. The broker counts the client as connected until the page is restored or evicted, because the client sends Keep Alive 0. The connection then ends without DISCONNECT, so the broker publishes the Will if one is set.

An application that must send DISCONNECT before the page enters the cache disconnects the client in its own `pagehide` handler, then creates a new reconnecting client and a new adapter in its `pageshow` handler.

## What was checked in a browser

`test/packed/page-lifecycle.ts` drives the packed adapter against Mosquitto over WebSocket, through a TCP proxy that counts connections and can make them stop answering. The scheduled CI job runs it in Chromium, Firefox and WebKit after it installs the browsers. These results are from Chromium 158.0.8127.36 with Playwright 1.65.1 in new headless mode, the only browser it has run in:

- A navigation to another page and `page.goBack()` restore the page from the back-forward cache. Chromium sends no `Page.backForwardCacheNotUsed` event. Leaving fires `pagehide` with `persisted` true, `visibilitychange` to hidden and `freeze`. The restore fires `resume` while the page is still hidden, then `visibilitychange` to visible and `pageshow` with `persisted` true. The adapter runs one check, on the `visibilitychange`.
- The proxy still holds the TCP connection of the cached page 2 seconds after the navigation. After the restore, the WebSocket fires `error`, the session ends with `ERR_MQTT_TRANSPORT`, and the next session connects at once although the backoff drew 10 to 20 seconds.
- A connection that stops answering while the page is hidden ends at the ping deadline after the return, and the next session connects about 1,100 milliseconds after the return with a `timeoutMs` of 1,000.
- A QoS 1 publication on a connection that stops answering rejects with `ERR_MQTT_TIMEOUT` after about 1,000 milliseconds while the page is hidden. The return then starts the next attempt at once, and its `connected` event lists the publication as uncertain.
- Across these steps, the page opens four connections, one per session, and each return reports one event.

Playwright starts Chromium with `--disable-back-forward-cache`, so the check removes that switch. The headless shell, Playwright's default Chromium, still refuses the cache with the reasons `BackForwardCacheDisabledForDelegate` and `BrowsingInstanceNotSwapped`, so the check launches the `chromium` channel. A headless page stays visible, so the steps after the restore dispatch `visibilitychange` with a replaced `document.visibilityState` getter. On a visible headless page, the DevTools command `Page.setWebLifecycleState` with `frozen` fired no `freeze` event. The only real freeze in the check is the one the back-forward cache causes.

`test/page-lifecycle.test.ts` covers the adapter with fake timers and event targets in Node. A ten-minute freeze moves the clock with `clock.jump` of the fake timers, so no timer runs during the pause and each overdue timer runs once at its end. The freeze tests run in both orders: the return before the overdue timers, and the overdue timers before the return. The fake clock runs the overdue timers one after another in one task, while a browser runs each in its own task. Other tests cover hidden to visible, the Chromium restore order, `pageshow` with `persisted` true, repeated events, an open attempt, a client that stopped while away, a ping of the application, `checkAfterMs` and the stop function. `test/reconnect.test.ts` covers `retryNow()`.

## Gaps

These need a real browser lifecycle test that has not run:

- Firefox and WebKit. The scheduled CI job runs the check in both. There it asserts the steps after the navigation, which dispatch `visibilitychange` and `pageshow`, and only reports whether `page.goBack()` restored the page from the cache. Neither browser has run the check yet, because their download host was blocked where this was written. Each needs a check of back-forward cache eligibility with an open WebSocket, whether the socket closes on entry or on restore, and the order of `pagehide`, `pageshow` and `visibilitychange`. The adapter does not need `freeze` and `resume`, but this was not checked in a browser without them.
- Timer throttling in a hidden tab. Playwright passes `--disable-background-timer-throttling`, so no check delays the retry timer the way a hidden tab does.
- A freeze outside the back-forward cache, such as Chromium freezing a background tab, and a discarded tab, which reloads instead of resuming.
- A device that sleeps while the page stays visible. No page event fires, so the adapter does not check. Until the browser closes the socket, a session that stopped answering ends only when an operation passes its deadline.
- Mobile browsers, which can hide and freeze a page more often than desktop ones.
