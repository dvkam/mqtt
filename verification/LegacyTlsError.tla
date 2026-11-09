---------------------------- MODULE LegacyTlsError ----------------------------
EXTENDS Naturals
CONSTANT Fault
VARIABLE state
vars == <<state>>

Init == state = [phase |-> "ready", destroyed |-> FALSE, emissions |-> 0]
Emit == /\ state.phase = "ready"
        /\ state' = [state EXCEPT !.phase = "emitting", !.emissions = 1]
Handle == /\ state.phase = "emitting"
          /\ state' = [state EXCEPT !.phase = "handled", !.destroyed = (Fault # "noDestroy"),
                        !.emissions = IF Fault = "reemit" THEN 2 ELSE @]
Observe == /\ state.phase = "handled"
           /\ state' = [state EXCEPT !.phase = "observed"]

Next == Emit \/ Handle \/ Observe
Spec == Init /\ [][Next]_vars

OneEmission == state.emissions <= 1
DestroyBeforeObservation == state.phase = "observed" => state.destroyed
=============================================================================
