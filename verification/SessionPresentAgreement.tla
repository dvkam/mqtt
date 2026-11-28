------------------------ MODULE SessionPresentAgreement ------------------------
\* Rule: After CONNECT with Clean Start true, a CONNACK with Session Present true ends the session with a protocol
\* error, also when that CONNACK refuses the connection.
\* Source: src/portable.ts (receiveConnack, cleanStart, connackReceived, rejectProtocolInput)
\* Tests: test/session-present.test.ts
\* Mapping: Receive is the Session Present check in receiveConnack, which runs before the reason code check.
\* LaterPresent is a later CONNACK, which the connackReceived guard rejects before it reads the flag. For that
\* reason no broken configuration limits the check to opening. Activate is open setting activation to active.
\* Deliver is the onMessage call.
\* Not modeled: Clean Start false and stored session state. With cleanStart false, receiveConnack accepts Session
\* Present true and open resumes the stored publications. No model covers that path. test/session-resume.test.ts
\* checks it. Packet bytes and the notice are also left out.
CONSTANT Fault
VARIABLES phase, cause, presentObserved, refusedPresent, delivered
vars == <<phase, cause, presentObserved, refusedPresent, delivered>>
Init == /\ phase = "opening" /\ cause = "none" /\ presentObserved = FALSE
        /\ refusedPresent = FALSE /\ delivered = FALSE
Receive(present, refused) ==
  /\ phase = "opening"
  /\ LET protocol == present /\ Fault # "guard" /\ ~(refused /\ Fault = "refusal")
     IN /\ phase' = IF protocol \/ refused THEN "failed" ELSE "accepted"
        /\ cause' = IF protocol THEN "protocol" ELSE IF refused THEN "refusal" ELSE "none"
  /\ presentObserved' = present /\ refusedPresent' = (present /\ refused)
  /\ UNCHANGED delivered
LaterPresent ==
  /\ phase \in {"accepted", "active"}
  /\ presentObserved' = TRUE
  /\ phase' = "failed"
  /\ cause' = "protocol"
  /\ UNCHANGED <<refusedPresent, delivered>>
Activate == /\ phase = "accepted" /\ phase' = "active"
            /\ UNCHANGED <<cause, presentObserved, refusedPresent, delivered>>
Deliver == /\ phase = "active" /\ ~delivered /\ delivered' = TRUE
           /\ UNCHANGED <<phase, cause, presentObserved, refusedPresent>>
Next == (\E present, refused \in BOOLEAN: Receive(present, refused)) \/ LaterPresent \/ Activate \/ Deliver
Spec == Init /\ [][Next]_vars
PresentRetires == presentObserved => phase = "failed"
RefusedPresentIsProtocol == refusedPresent => cause = "protocol"
=============================================================================
