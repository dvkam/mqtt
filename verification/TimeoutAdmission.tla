----------------------------- MODULE TimeoutAdmission -----------------------------
\* Rule: An invalid timeoutMs rejects before the client opens a socket or registers a listener. Operations use the
\* value accepted then, not a later change to the options object.
\* Source: src/timeout.ts (resolveTimeout)
\* Source: src/transportCore.ts (connectOverBytes)
\* Source: src/portable.ts (PortableClient, run, timeoutMs)
\* Source: src/websocket.ts (openMqttWebSocket)
\* Tests: test/timeout-validation.test.ts
\* Mapping: Configure is resolveTimeout in connectOverBytes before transport.open, in the PortableClient constructor
\* before transport.listen, and in openMqttWebSocket before the WebSocket constructor. Mutate is the caller changing
\* its options object. Operate is run reading the private timeoutMs.
\* Not modeled: Numeric values, which the model reduces to valid and invalid, and the drain timeout of disconnect().
CONSTANT Fault
VARIABLES phase, configured, accepted, used, acquired
vars == <<phase, configured, accepted, used, acquired>>
Init == /\ phase = "new" /\ configured \in {"valid", "invalid"}
        /\ accepted = "none" /\ used = "none" /\ acquired = FALSE
Configure == /\ phase = "new"
             /\ phase' = IF configured = "valid" \/ Fault = "validation" THEN "active" ELSE "rejected"
             /\ acquired' = (configured = "valid" \/ Fault = "validation")
             /\ accepted' = configured
             /\ UNCHANGED <<configured, used>>
Mutate == /\ phase = "active" /\ configured = "valid" /\ configured' = "invalid"
          /\ UNCHANGED <<phase, accepted, used, acquired>>
Operate == /\ phase = "active" /\ used = "none"
           /\ used' = IF Fault = "snapshot" THEN configured ELSE accepted
           /\ UNCHANGED <<phase, configured, accepted, acquired>>
Next == Configure \/ Mutate \/ Operate
Spec == Init /\ [][Next]_vars
ValidateBeforeAcquire == acquired => accepted = "valid"
RetainAcceptedDeadline == used # "none" => used = accepted
=============================================================================
