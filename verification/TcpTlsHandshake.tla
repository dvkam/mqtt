---------------------------- MODULE TcpTlsHandshake --------------------------
\* Rule: MQTT starts on a TLS connection only after Node verified the certificate. The first opening failure stays
\* the cause. A failed opening has closed the socket, cleared the timer and removed the abort listener.
\* Source: src/tcpClient.ts (openTcpSocket, connectionEvent, settle)
\* Source: src/transportCore.ts (connectOverBytes)
\* Source: src/packetInput.ts (PacketInput, retire)
\* Tests: test/tcp-tls.test.ts
\* Mapping: TcpConnected is the TCP connect, which resolves nothing when TLS is on. Authenticate is the
\* secureConnect event with rejectUnauthorized true. StartMqtt is connected resolving the writer, after which the
\* core calls connectPortable. Reject is an abort, a socket error or the opening timer destroying the socket, where
\* retire keeps the first cause. NativeClose is the close event. SettleFailure is failed calling settle and
\* rejecting the open.
\* Not modeled: The certificate checks, which Node performs, the server name, and the CONNACK result.
EXTENDS Naturals
CONSTANT Fault
VARIABLE state
vars == <<state>>

Init ==
  state = [phase |-> "opening", authenticated |-> FALSE, mqtt |-> FALSE,
           cause |-> "none", first |-> "none", closed |-> FALSE,
           timer |-> TRUE, signal |-> TRUE, settled |-> FALSE]

TcpConnected ==
  /\ state.phase = "opening"
  /\ state' = [state EXCEPT !.phase = "tcp"]

Authenticate ==
  /\ state.phase = "tcp"
  /\ state' = [state EXCEPT !.phase = "authenticated", !.authenticated = TRUE]

StartMqtt ==
  /\ state.phase = "authenticated" \/ (Fault = "early" /\ state.phase = "tcp")
  /\ state' = [state EXCEPT !.phase = "mqtt", !.mqtt = TRUE,
                           !.timer = FALSE, !.settled = TRUE]

Reject(reason) ==
  /\ state.phase # "mqtt" /\ ~state.closed
  /\ state' = [state EXCEPT !.phase = "retired",
                 !.first = IF state.first = "none" THEN reason ELSE state.first,
                 !.cause = IF state.cause = "none" \/ Fault = "replace" THEN reason ELSE state.cause]

NativeClose ==
  /\ state.phase = "retired" /\ ~state.closed
  /\ state' = [state EXCEPT !.closed = TRUE, !.signal = (Fault = "leak")]

SettleFailure ==
  /\ state.closed /\ ~state.settled
  /\ state' = [state EXCEPT !.timer = FALSE, !.settled = TRUE]

Next == TcpConnected \/ Authenticate \/ StartMqtt
        \/ (\E reason \in {"abort", "native", "timeout"}: Reject(reason))
        \/ NativeClose \/ SettleFailure
Spec == Init /\ [][Next]_vars

MqttRequiresAuthentication == state.mqtt => state.authenticated
FirstFailureWins == state.cause = state.first
SettledFailureReleasesResources ==
  state.settled /\ state.first # "none" => state.closed /\ ~state.timer /\ ~state.signal
=============================================================================
