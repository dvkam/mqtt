# Connection and operation deadlines

The supported client factories and custom packet client accept timeoutMs as an integer from 1 through 2,147,483,647 milliseconds. Omitting it selects 3,000 milliseconds. Zero, negative values, fractions, NaN and infinities reject with RangeError. Validation happens before TCP endpoint access, custom transport registration or native WebSocket construction. A signal already aborted when the Node or native WebSocket attempt starts keeps its existing precedence.

Each supported factory captures its timeout when connect starts and uses that value through the transport-to-session handoff. The shared session keeps its own validated numeric deadline. Changing the original options afterward does not change active operation timers. This is not a promise to snapshot every other option.

These are relative timeout budgets. They do not guarantee exact scheduling or a single end-to-end deadline across connection, acknowledgment and graceful close. Separate stages can each use the configured budget. Event-loop stalls can delay timer callbacks.

The validation review added failing-before tests for TCP endpoint access, custom transport registration and fractional native WebSocket timeouts. It also caught a browser handoff leak introduced by revalidating caller-mutated options after opening the socket. A regression now changes timeoutMs during each adapter's handshake and checks that the original attempt completes and disconnects.

The TimeoutAdmission model abstracts valid and invalid configuration, resource acquisition, one caller mutation and one operation. It checks admission before acquisition and reuse of the accepted deadline. Concrete tests cover actual numeric boundaries and adapter handoff. The model does not prove native timer behavior, callback fairness or physical socket cleanup.

Outgoing work after an operation timeout remains part of #11. Incoming packet limits and valid timer configuration do not bound unresolved native writes. See [the tracked work](https://github.com/dvkam/mqtt/issues/11) before treating the preview as a fully bounded outgoing client.
