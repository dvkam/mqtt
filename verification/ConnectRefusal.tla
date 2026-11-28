----------------------------- MODULE ConnectRefusal -----------------------------
\* Rule: A refused CONNACK retires the session in the call that receives it, and a later transport close does not
\* replace the refusal as the cause.
\* Source: src/portable.ts (receiveConnack, connackRefusal, fail)
\* Tests: test/portable.test.ts, test/tcp-client.test.ts
\* Mapping: Refuse is receiveConnack calling fail with the refusal while the CONNECT exchange is pending. Accept is
\* a CONNACK with reason code 0. Close is the transport's close callback calling fail. RepeatClose is a second fail,
\* which the failure guard ignores.
\* Not modeled: The refusal's reason code and properties, and a refusal that arrives before CONNECT was sent.
CONSTANT Fault
VARIABLES phase, reason, firstReason, refusalSeen, queued
vars == <<phase, reason, firstReason, refusalSeen, queued>>
Init == /\ phase = "waiting" /\ reason = "none" /\ firstReason = "none"
        /\ refusalSeen = FALSE /\ queued = FALSE
Refuse == /\ phase = "waiting" /\ ~refusalSeen /\ refusalSeen' = TRUE
          /\ firstReason' = "refusal" /\ queued' = (Fault = "defer")
          /\ phase' = IF Fault = "defer" THEN "waiting" ELSE "failed"
          /\ reason' = IF Fault = "defer" THEN "none" ELSE "refusal"
ProcessQueued == /\ phase = "waiting" /\ queued /\ phase' = "failed"
                 /\ reason' = "refusal" /\ queued' = FALSE
                 /\ UNCHANGED <<firstReason, refusalSeen>>
Accept == /\ phase = "waiting" /\ ~refusalSeen /\ phase' = "active"
          /\ UNCHANGED <<reason, firstReason, refusalSeen, queued>>
Close == /\ phase # "failed" /\ phase' = "failed" /\ reason' = "transport"
         /\ firstReason' = IF firstReason = "none" THEN "transport" ELSE firstReason
         /\ UNCHANGED <<refusalSeen, queued>>
RepeatClose == /\ phase = "failed" /\ Fault = "overwrite" /\ reason' = "later transport"
               /\ UNCHANGED <<phase, firstReason, refusalSeen, queued>>
Next == Refuse \/ ProcessQueued \/ Accept \/ Close \/ RepeatClose
Spec == Init /\ [][Next]_vars
FirstTerminalReason == phase = "failed" => reason = firstReason
=============================================================================
