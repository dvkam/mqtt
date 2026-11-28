------------------------------ MODULE WebSocketOpen ------------------------------
\* Rule: One opening attempt either hands the socket to the caller or rejects and requests one close.
\* Source: src/websocket.ts (openMqttWebSocket, opened, fail, cleanup)
\* Tests: test/websocket.test.ts
\* Mapping: Open is opened settling the outcome open, after which openMqttWebSocket returns the socket. Fail is fail,
\* for an abort, an error, a close, the timeout or a missing subprotocol. It settles a failed outcome, after which
\* openMqttWebSocket throws. Its cleanup removes the open listener, so a late open event reaches nothing.
\* KeepOpenListener = TRUE leaves that listener in place.
\* Not modeled: Physical socket closure. The counter counts handler effects. The ws opening in
\* src/websocketClient.ts is also left out.
EXTENDS Naturals

CONSTANT KeepOpenListener
VARIABLES outcome, listening, count, closeRequests
vars == <<outcome, listening, count, closeRequests>>

Init ==
  /\ outcome = "pending"
  /\ listening = TRUE
  /\ count = 0
  /\ closeRequests = 0

Open ==
  /\ listening
  /\ outcome' = "opened"
  /\ listening' = FALSE
  /\ count' = count + 1
  /\ UNCHANGED closeRequests

Fail ==
  /\ outcome = "pending"
  /\ outcome' = "rejected"
  /\ listening' = KeepOpenListener
  /\ count' = count + 1
  /\ closeRequests' = closeRequests + 1

Next == Open \/ Fail
Spec == Init /\ [][Next]_vars
TerminalOwnership == count <= 1 /\ closeRequests <= 1
=============================================================================
