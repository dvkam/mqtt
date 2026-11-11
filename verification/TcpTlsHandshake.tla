---------------------------- MODULE TcpTlsHandshake --------------------------
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
