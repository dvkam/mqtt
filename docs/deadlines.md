# Connection and operation deadlines

The built-in and custom byte transport factories accept timeoutMs as an integer from 1 through 2,147,483,647 milliseconds. Omitting it selects 3,000 milliseconds. Zero, negative values, fractions, NaN and infinities reject with RangeError. Validation happens before TCP endpoint access, opening a custom transport or native WebSocket construction. A signal already aborted when the Node or native WebSocket attempt starts keeps its existing precedence.

Each supported factory captures its timeout when connect starts and uses that value through the transport-to-session handoff. The shared session keeps its own validated numeric deadline. Changing the original options afterward does not change active operation timers. This is not a promise to snapshot every other option.

These are relative timeout budgets. They do not guarantee exact scheduling or a single end-to-end deadline across connection, acknowledgment and graceful close. Separate stages can each use the configured budget. Event-loop stalls can delay timer callbacks.

The validation review added failing-before tests for TCP endpoint access, opening a custom transport and fractional native WebSocket timeouts. It also caught a browser handoff leak introduced by revalidating caller-mutated options after opening the socket. A regression now changes timeoutMs during each adapter's handshake and checks that the original attempt completes and disconnects.

The TimeoutAdmission model abstracts valid and invalid configuration, resource acquisition, one caller mutation and one operation. It checks admission before acquisition and reuse of the accepted deadline. Concrete tests cover actual numeric boundaries and adapter handoff. The model does not prove native timer behavior, callback fairness or physical socket cleanup.

An operation timeout retires the session in its timer callback. Pending publication, subscription and ping calls reject with the first timeout error. Create a new client factory for another connection attempt. A timed-out QoS 0 write may already have reached the broker.

Once disconnect starts, `drainTimeoutMs` bounds the wait for active QoS 1 publications. The DISCONNECT write then has its own operation deadline. The outgoing publications' original timers no longer govern shutdown. [Drain and delivery outcomes](qos1-publish.md#disconnect-with-active-publications)

QoS 0 writes share a timer, with an expiry recorded for each write. A write that settles while the oldest pending expiry is already due triggers the same retirement. An idle timer keeps no session reference and stops holding the Node process open. Session retirement clears the timer. [Measurements](measurements.md#shared-qos-0-write-deadline)

Retirement creates one forced-close request. The transport close call runs in a later microtask. A throwing transport listener cleanup does not prevent the request, and a rejected close promise is observed. Pending publish, subscribe and ping failures do not wait for that promise. Opening and disconnect still await forced cleanup. A custom byte transport must settle its forced close promptly. An adapter that leaves this promise pending indefinitely can also leave opening or disconnect pending.

Byte and operation admission before the deadline remains part of #11. This retirement policy prevents repeated timed-out retries on one session; it does not bound a burst of concurrent writes before expiry. Incoming packet limits do not bound outgoing work. See [the tracked work](https://github.com/dvkam/mqtt/issues/11) before treating the preview as a fully bounded outgoing client.

## Server Keep Alive

Clients send CONNECT with Keep Alive `0`. A successful CONNACK can supply a positive Server Keep Alive in seconds. The idle deadline starts at the completed CONNECT write. Each successful outbound MQTT write moves it forward. When the deadline expires, the session starts a PINGREQ. It waits for PINGRESP until the operation timeout or the next idle deadline, whichever comes first.

There is one PINGRESP slot. A manual ping can wait on an automatic ping already in progress. A second manual ping still rejects while another manual ping owns the slot. If the idle deadline expires while a response is pending, the session closes without sending another ping. Traffic keeps moving the idle deadline while the operation timeout runs. Timeout retires the session and keeps the first error. Keep Alive continues through a QoS 1 drain and stops before the DISCONNECT write. Retirement also stops the idle timer. An absent or zero server value leaves automatic pings off.

A suspended browser tab can miss the idle deadline. [#15](https://github.com/dvkam/mqtt/issues/15) tracks the requirements ledger. [#16](https://github.com/dvkam/mqtt/issues/16) tracks negotiated MQTT behavior. [Page lifecycle](page-lifecycle.md) describes how a reconnecting client is checked when the page returns, and [#181](https://github.com/dvkam/mqtt/issues/181) tracks Server Keep Alive.
