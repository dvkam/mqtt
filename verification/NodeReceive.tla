----------------------------- MODULE NodeReceive -----------------------------
EXTENDS Integers
CONSTANT Fault
VARIABLES requested, configured, constructed, nativeLimit, receiverFailed,
          notified, observerReady, coreFailed, terminationRequested, excessAdmitted
vars == <<requested, configured, constructed, nativeLimit, receiverFailed,
          notified, observerReady, coreFailed, terminationRequested, excessAdmitted>>
\* Scale signed 32-bit boundaries to signed 3-bit boundaries for TLC integers.
\* Runtime tests cover the actual 2^31 and 2^32 values.
Valid == requested >= 1 /\ requested <= 3
SignedLimit(value) == LET reduced == value % 8
                     IN IF reduced >= 4 THEN reduced - 8 ELSE reduced
Init == /\ requested \in {0, 1, 2, 3, 4, 8}
        /\ configured = FALSE /\ constructed = FALSE /\ nativeLimit = 0
        /\ receiverFailed = FALSE /\ notified = FALSE /\ observerReady = FALSE /\ coreFailed = FALSE
        /\ terminationRequested = FALSE /\ excessAdmitted = FALSE
Configure == /\ ~configured /\ configured' = TRUE
             /\ constructed' = (Valid \/ Fault = "validate")
             /\ nativeLimit' = IF Valid \/ Fault = "validate"
                               THEN IF Fault = "forward" THEN 3 ELSE SignedLimit(requested)
                               ELSE 0
             /\ UNCHANGED <<requested, receiverFailed, notified, observerReady, coreFailed, terminationRequested, excessAdmitted>>
AttachObserver == /\ constructed /\ ~receiverFailed /\ ~observerReady /\ observerReady' = TRUE
                  /\ UNCHANGED <<requested, configured, constructed, nativeLimit, receiverFailed, notified, coreFailed, terminationRequested, excessAdmitted>>
Receive(size) == /\ constructed /\ ~receiverFailed
                 /\ receiverFailed' = (nativeLimit > 0 /\ size > nativeLimit)
                 /\ excessAdmitted' = (excessAdmitted \/ (Valid /\ size > requested /\ (nativeLimit <= 0 \/ size <= nativeLimit)))
                 /\ UNCHANGED <<requested, configured, constructed, nativeLimit, notified, observerReady, coreFailed, terminationRequested>>
Notify == /\ receiverFailed /\ ~notified /\ notified' = TRUE
          /\ coreFailed' = (observerReady /\ Fault # "notify")
          /\ terminationRequested' = (Fault # "terminate")
          /\ UNCHANGED <<requested, configured, constructed, nativeLimit, receiverFailed, observerReady, excessAdmitted>>
Next == Configure \/ AttachObserver \/ (\E size \in 1..4: Receive(size)) \/ Notify
Spec == Init /\ [][Next]_vars
InvalidConfigNoConstruction == ~Valid => ~constructed
BoundedNativeReceive == ~excessAdmitted
ErrorRetiresCore == (notified /\ observerReady) => coreFailed
ErrorRequestsTermination == notified => terminationRequested
=============================================================================
