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

So a session that stopped answering while the page was away ends at most `timeoutMs` after the return. Until then `session()` still returns it. Every publish, subscribe and ping keeps its own `timeoutMs` deadline. A hidden tab can run that deadline late, as [timers in a hidden tab](#timers-in-a-hidden-tab) describes. A frozen page runs no timer, and its overdue timers run once it resumes. In Chromium 159, the WebSocket also failed when the page resumed, both after a freeze through DevTools and after a restore from the back-forward cache. So an operation that was pending through a freeze rejects as soon as the page runs again, with `ERR_MQTT_TRANSPORT` when the WebSocket failed first and with `ERR_MQTT_TIMEOUT` otherwise.

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

## Timers in a hidden tab

Chromium runs the timers of a hidden tab at most once a second. Once the tab was hidden for 5 minutes, it runs a chain of timers at most once a minute. A timer is part of a chain when it was set from the callback of another timer, five levels deep. The retry loop of a client whose attempts time out is such a chain. So is the deadline of an operation that the application starts from a `setInterval` callback.

So while the tab is hidden, a `timeoutMs` deadline can pass up to 1 second late. In a chain, a deadline or the retry timer can pass up to 1 minute late. The adapter does not shorten these waits, because it acts only on a return. On the return, the browser runs the overdue timers, and the check does one of two things:

- When the client waits for its retry timer, `retryNow()` starts the attempt at once.
- When an attempt is open, the check does nothing and reports `connecting`. The overdue deadline ends that attempt, and the client then waits its backoff delay before the next attempt. With the default `maxDelayMs`, that delay is 30,000 milliseconds at most.

Firefox and Safari throttle the timers of hidden tabs by rules of their own. No check here measured them.

## Discarded tabs

A browser can discard a hidden tab to free memory. Chromium fires `pagehide` with `persisted` false, closes the WebSocket without DISCONNECT and drops the document. The broker then publishes the Will if one is set. When the user returns, the tab loads again, and `document.wasDiscarded` is true in the new document. Nothing of the old client is left, so the adapter has no return to check. The new document creates its client and connects once. A QoS 1 publication that was in flight is lost with the old document, because the [session state](reconnect.md) lives in memory.

## Pages in the back-forward cache

On a `pagehide` with `persisted` true, the adapter leaves the connection open. A reconnecting client cannot connect again after a disconnect, so a disconnect on `pagehide` would leave nothing to restore. Chromium keeps such a page in the back-forward cache with its WebSocket. When the page is restored, the WebSocket fails, the session ends, and the adapter starts the next attempt at once. The broker counts the client as connected until the page is restored or evicted, because the client sends Keep Alive 0. The connection then ends without DISCONNECT, so the broker publishes the Will if one is set.

An application that must send DISCONNECT before the page enters the cache disconnects the client in its own `pagehide` handler, then creates a new reconnecting client and a new adapter in its `pageshow` handler.

## What was checked in a browser

The `browsers` job in `.github/workflows/ci.yml` runs once for each of Chromium, Firefox and WebKit on `ubuntu-26.04`. It runs on the weekly schedule, on a manual run of the workflow, and on a pull request that changes a file under `src`, `test/packed` or `test/experiments`, or one of `tsconfig.json`, `package.json`, `pnpm-lock.yaml`, `.node-version` and `.github/workflows/ci.yml`. It does not run on a push to `main`, and it is not a required check. The job step "Run the page lifecycle check" runs `test/packed/page-lifecycle.sh`, which starts Mosquitto with a WebSocket listener and drives the packed adapter through a TCP proxy. The proxy counts connections and can make them stop answering.

The results below are from the `browsers` jobs of [run 46144703278](https://github.com/dvkam/mqtt/actions/runs/46144703278) on 28 November 2026, with Playwright 1.65.1, Chrome for Testing 159.0.8154.6, Firefox 159.0 and WebKit 27.2. Every client had a `timeoutMs` of 1,000. The same checks passed in the same three builds in a local Ubuntu 24.04 container.

### A navigation away and back

`test/packed/page-lifecycle.ts` runs in all three browsers. It navigates three pages to another page, waits and calls `page.goBack()`: a page without a client, a page with a connected client, and a page whose client waits for its retry timer and so holds no WebSocket.

| | Chromium 159.0.8154.6 | Firefox 159.0 | WebKit 27.2 |
| --- | --- | --- | --- |
| `page.goBack()` restored the page from the back-forward cache | Yes, all three pages | No, none of them | No, none of them |
| Events when the page left | `pagehide` with `persisted` true, `visibilitychange` to hidden, `freeze` | `pagehide` with `persisted` false, `visibilitychange` to hidden | `pagehide` with `persisted` false, `visibilitychange` to hidden |
| Events when the page came back | `resume` while hidden, `visibilitychange` to visible, `pageshow` with `persisted` true | A new document loaded | A new document loaded |
| WebSocket of the connected page | The proxy still held the connection 2 seconds after the navigation. After the restore, the WebSocket fired `error` and the session ended with `ERR_MQTT_TRANSPORT` | The WebSocket fired `close` before `pagehide`, and the client armed its retry timer in the page that was unloading. The proxy saw the connection close 4 milliseconds after the navigation started | The page recorded no WebSocket event before `pagehide`. The proxy saw the connection close 3 milliseconds after the navigation started |
| Adapter | One check on the `visibilitychange`, outcome `retried`, for the connected and for the waiting client | No return. The page that was unloading opened no connection | No return. The page that was unloading opened no connection |
| Next session | Connected 104 milliseconds after the return, although the backoff drew 10 to 20 seconds | The new document opened one connection | The new document opened one connection |

Chromium sent no `Page.backForwardCacheNotUsed` event. Playwright starts Chromium with `--disable-back-forward-cache`, so the check removes that switch. The headless shell, Playwright's default Chromium, still refuses the cache with the reasons `BackForwardCacheDisabledForDelegate` and `BrowsingInstanceNotSwapped`, so the check launches the `chromium` channel in new headless mode.

Playwright's Firefox and WebKit builds do not use the back-forward cache. The page without a client received `pagehide` with `persisted` false in both, so the open WebSocket is not the reason. The `playwright.cfg` of the Firefox build sets `fission.bfcacheInParent` to false, and its comment says that the build also turns the cache off in content through a docShell property. A Firefox started with the preference `browser.sessionhistory.max_total_viewers` at 8 still unloaded that page. With `fission.bfcacheInParent` true as well, `page.goBack()` did not finish within 20 seconds. Playwright has no launch option for the WebKit setting. The check asserts the unload in both browsers, so it fails when a later Playwright build starts to cache the page.

The remaining steps dispatch `visibilitychange` with a replaced `document.visibilityState` getter, because a page that Playwright launched stays visible. They passed in all three browsers:

- A connection that stops answering while the page is hidden ends at the ping deadline after the return. The next session connected 1,112, 1,113 and 1,111 milliseconds after the return in Chromium, Firefox and WebKit.
- A QoS 1 publication on a connection that stops answering rejected with `ERR_MQTT_TIMEOUT` after 1,001, 1,001 and 1,002 milliseconds while the page was hidden. The return then started the next attempt at once. The next session connected 111, 113 and 114 milliseconds after the return, and its `connected` event listed the publication as uncertain.
- A dispatched `pagehide` and `pageshow` with `persisted` true on a healthy session ran one check with the trigger `pageshow` and the outcome `answered`, and opened no connection.
- Each return reported one event, and each session opened one connection.

### A hidden, frozen or discarded tab in Chromium

`test/packed/page-lifecycle-hidden.ts` is the hidden tab check. It runs in the Chromium job only. A page that Playwright launched cannot be hidden. Playwright turns on focus emulation for every page, which keeps `document.visibilityState` at `visible` behind another tab, and it passes `--disable-background-timer-throttling`, `--disable-backgrounding-occluded-windows` and `--disable-renderer-backgrounding`. Removing the three switches and turning focus emulation off from a second DevTools session left the page visible, in new headless mode and in a window under Xvfb. So the hidden tab check starts the Chromium binary itself in new headless mode, with none of Playwright's switches, and attaches Playwright with `connectOverCDP` and `noDefaults`. A second tab in front then hides the tab of the client, and the browser fires `visibilitychange` itself. The hidden tab check also passed with Chromium 158.0.8127.36 and in a window under Xvfb with `MQTT_TEST_HEADED=1`.

- **Timers once a second.** Three timers of 10 milliseconds in a row took 30 milliseconds in the visible tab and 2,195 in the hidden one. A QoS 1 publication on a connection that stopped answering rejected with `ERR_MQTT_TIMEOUT` after 1,997 milliseconds in the hidden tab. The retry timer of 10 to 20 seconds then started no attempt for 1,500 milliseconds. The return fired `visibilitychange`, the adapter reported `retried` once, and the next session connected 110 milliseconds after the return with the publication listed as uncertain.
- **A silent connection.** A connection that stopped answering opened no new connection while the tab stayed hidden for 1,500 milliseconds. After the return, the ping ended the session and the next session connected after 1,113 milliseconds.
- **Timers once a minute.** The switch `--enable-features=IntensiveWakeUpThrottling:grace_period_seconds/10` shortens the 5 minutes to 10 seconds. A client with a retry delay of 200 milliseconds faced a proxy that accepted each connection and stayed silent. The check returned to the tab twice. The first time, an attempt was 3,000 milliseconds past its deadline of 1,000 milliseconds. The adapter reported `connecting`, the deadline ended the attempt, and the next session connected 255 milliseconds after the return. The second time, one attempt had stayed open for 10,016 milliseconds, and the retry timer of 200 milliseconds was 3,010 milliseconds overdue. The adapter reported `retried`, and the next session connected 104 milliseconds after the return.
- **A frozen tab.** The DevTools command `Page.setWebLifecycleState` froze the hidden tab for 3 seconds. The page fired `freeze` and, after the command with `active`, `resume` while it was still hidden. The proxy held the connection through the freeze. On resume, the WebSocket of a healthy session fired `error`, the session ended with `ERR_MQTT_TRANSPORT`, and the adapter ran no check, because the tab was still hidden. A QoS 1 publication that was pending through the freeze rejected with `ERR_MQTT_TRANSPORT` 3,003 milliseconds after it was sent. The return to the tab then reported `retried` once, and the next session connected 114 and 115 milliseconds after it.
- **A discarded tab.** Chromium discards no tab that has a DevTools session, and Playwright keeps one on every page. So a second Chromium loads an extension with `--load-extension`, and a DevTools connection to the extension's service worker calls `chrome.tabs.discard` for the hidden tab, as a tab manager extension does. The tab posts its log to the test server. It received `pagehide` with `persisted` false, and the proxy saw its connection close 12 milliseconds after the call. It opened no connection for 1,500 milliseconds. After `Target.activateTarget`, the tab loaded again with `document.wasDiscarded` true, its log held one `connected` entry with generation 1, and it opened one connection, 130 milliseconds after the return. Opening `chrome://discards`, which can discard a tab too, crashed Chrome for Testing 159.0.8154.6.

### Tests without a browser

`test/page-lifecycle.test.ts` covers the adapter with fake timers and event targets in Node. A ten-minute freeze moves the clock with `clock.jump` of the fake timers, so no timer runs during the pause and each overdue timer runs once at its end. The freeze tests run in both orders: the return before the overdue timers, and the overdue timers before the return. The fake clock runs the overdue timers one after another in one task, while a browser runs each in its own task. Other tests cover hidden to visible, the Chromium restore order, `pageshow` with `persisted` true, repeated events, an open attempt, a client that stopped while away, a ping of the application, `checkAfterMs` and the stop function. `test/reconnect.test.ts` covers `retryNow()`.

## Gaps

No automated check covers these:

- The back-forward cache of Firefox and Safari. Playwright's builds of both unload the page, as the table above shows. Whether a page with an open WebSocket enters the cache, when the socket closes and in which order `pageshow` and `visibilitychange` fire are unknown here. The adapter needs only one of the two events, and it does not need `freeze` or `resume`.
- Timer throttling in Firefox and Safari, and a tab that Chromium freezes or discards by its own rules. The hidden tab check freezes and discards the tab on command, and it shortens the 5 minutes before one wake-up a minute to 10 seconds.
- A device that sleeps while the page stays visible. No page event fires, so the adapter does not check. Until the browser closes the socket, a session that stopped answering ends only when an operation passes its deadline. A test cannot put the CI machine to sleep. The clock jump tests cover what the adapter and the client do with overdue timers.
- Mobile browsers. Playwright's device emulation sets the viewport, the user agent and touch input of a desktop browser. It does not background the application, lock the screen or suspend the process, so it shows nothing about a phone's page lifecycle.

## Manual checks

These steps cover the gaps on a real device. Nobody has run them yet, and the expected results follow from the adapter's rules above, not from a measurement.

Build and pack the package, install the tarball in an empty directory as the `browsers` job does, and start a Mosquitto with a WebSocket listener. Then run `node test/packed/page-lifecycle-manual.ts <directory> ws://127.0.0.1:<port>/mqtt`. It prints a URL for each network address of the machine and each change of the connections the proxy holds. Open the URL that the device can reach. The page shows its log with the milliseconds of `performance.now()`. Its client has a `timeoutMs` of 1,000, a retry delay of 10 to 20 seconds and a `maxAttempts` of 5.

The script listens on `0.0.0.0`, and its proxy passes every connection on to the broker, which accepts anonymous clients. Run it only on a network you trust, and stop it after the checks.

Run each step in Safari on iOS and in Chrome on Android. Before each step, wait for a `connected` entry. A step whose return finds the client stopped needs a reload of the page first.

| Step | Expected |
| --- | --- |
| Switch to another application for 30 seconds and come back | One `return` entry with one of the outcomes below |
| Switch to another application for 6 minutes and come back | One `return` entry with one of the outcomes below. A `retrying` entry before it means the browser closed the WebSocket while the page was away |
| Lock the screen for 1 minute and unlock it | One `return` entry with one of the outcomes below |
| Turn airplane mode on for 10 seconds while the page is visible, then off | No `return` entry, because no page event fires. When the browser closes the WebSocket, a `retrying` entry appears, and a `connected` entry follows after the retry delay of 10 to 20 seconds, once the network is back. When the browser keeps the WebSocket, the log and the proxy show no change. Switch to another application and back then, and expect one `return` entry with `answered` or `retried` |
| Switch the device to another network while the browser is in the background, and come back. This step needs a machine that both networks reach | One `return` entry with one of the outcomes below. `answered` after a `retrying` and a `connected` entry means the retry timer reconnected over the new network before the return |
| Navigate the tab to another page and go back | With `pageshow persisted=true` in the log, the page came from the back-forward cache, and one `return` entry belongs to that return. Chromium logs that entry before the `pageshow` entry. Without `pageshow persisted=true`, the page loaded again and its log starts with one `connected` entry |

Each return must log one `return` entry. Its outcome decides what else the log and the proxy show:

| Outcome | Expected after it |
| --- | --- |
| `answered` | No new `connected` entry and no new connection at the proxy. A `retrying` and a `connected` entry before the `return` entry mean that the client reconnected by its retry timer while the page was away, with one connection at the proxy for each `connected` entry |
| `retried` | One `connected` entry within 2 seconds, and one new connection at the proxy. Without a network, a `retrying` entry follows instead |
| `connecting` | An attempt was open at the return. A `connected` entry or a `retrying` entry follows within 1 second. After a `retrying` entry, the next attempt waits 10 to 20 seconds |
| `ended` | The ping failed while an attempt was already open or the client had stopped. The next entry shows which of the two it was |
| `stopped` | A `stopped` entry is in the log. With `exhausted`, five attempts since the last stable session failed while the page was away. The client opens no connection again. Reload the page |

Record the browser version, the trigger and the outcome of the `return` entry, the order of the page events and the milliseconds between the `return` entry and the `connected` entry.

The last step also covers the back-forward cache of Firefox and Safari on a desktop.
