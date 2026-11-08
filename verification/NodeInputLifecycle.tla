--------------------------- MODULE NodeInputLifecycle ---------------------------
EXTENDS Naturals
CONSTANT Fault
VARIABLES owner, kind, partial, remotePartial, registered, everRegistered, notified,
          reason, firstReason, notifiedReason, decoderStopped, finishes, lateRead, unownedNotification
vars == <<owner, kind, partial, remotePartial, registered, everRegistered, notified,
          reason, firstReason, notifiedReason, decoderStopped, finishes, lateRead, unownedNotification>>
Init == /\ owner = "open" /\ kind = "none" /\ partial = FALSE /\ remotePartial = FALSE
        /\ registered = FALSE /\ everRegistered = FALSE /\ notified = FALSE
        /\ reason = "none" /\ firstReason = "none" /\ notifiedReason = "none"
        /\ decoderStopped = FALSE /\ finishes = 0 /\ lateRead = FALSE /\ unownedNotification = FALSE
Begin == /\ owner = "open" /\ ~partial /\ partial' = TRUE
         /\ UNCHANGED <<owner, kind, remotePartial, registered, everRegistered, notified,
                        reason, firstReason, notifiedReason, decoderStopped, finishes, lateRead, unownedNotification>>
Boundary == /\ owner = "open" /\ partial /\ partial' = FALSE
            /\ UNCHANGED <<owner, kind, remotePartial, registered, everRegistered, notified,
                           reason, firstReason, notifiedReason, decoderStopped, finishes, lateRead, unownedNotification>>
Register == /\ ~everRegistered /\ owner # "core" /\ registered' = TRUE /\ everRegistered' = TRUE
            /\ notified' = (owner = "input" /\ Fault # "replay")
            /\ notifiedReason' = IF owner = "input" /\ Fault # "replay" THEN reason ELSE "none"
            /\ UNCHANGED <<owner, kind, partial, remotePartial, reason, firstReason,
                           decoderStopped, finishes, lateRead, unownedNotification>>
Retire(cause) == /\ owner = "open" /\ owner' = "input" /\ kind' = cause
                 /\ reason' = "original" /\ firstReason' = "original"
                 /\ decoderStopped' = (Fault # "stop") /\ notified' = registered
                 /\ notifiedReason' = IF registered THEN "original" ELSE "none"
                 /\ unownedNotification' = (registered /\ Fault = "order")
                 /\ UNCHANGED <<partial, remotePartial, registered, everRegistered, finishes, lateRead>>
RemoteEnd == /\ owner = "open" /\ owner' = "input" /\ kind' = "remote"
             /\ remotePartial' = partial /\ finishes' = finishes + 1 /\ decoderStopped' = TRUE
             /\ reason' = IF partial /\ Fault # "eof" THEN "truncation" ELSE "original"
             /\ firstReason' = reason' /\ notified' = registered
             /\ notifiedReason' = IF registered THEN reason' ELSE "none"
             /\ unownedNotification' = (registered /\ Fault = "order")
             /\ UNCHANGED <<partial, registered, everRegistered, lateRead>>
DetachCore == /\ owner = "open" /\ kind' = "core" /\ registered' = FALSE
              /\ owner' = IF Fault = "leak" THEN "input" ELSE "core"
              /\ reason' = IF Fault = "leak" THEN "synthetic" ELSE "none"
              /\ firstReason' = reason' /\ decoderStopped' = (Fault # "stop")
              /\ UNCHANGED <<partial, remotePartial, everRegistered, notified, notifiedReason,
                             finishes, lateRead, unownedNotification>>
UnlistenInput == /\ owner = "input" /\ registered /\ registered' = FALSE
                 /\ UNCHANGED <<owner, kind, partial, remotePartial, everRegistered, notified,
                                reason, firstReason, notifiedReason, decoderStopped, finishes, lateRead, unownedNotification>>
RepeatEnd == /\ owner # "open" /\ Fault = "repeat" /\ finishes < 2 /\ finishes' = finishes + 1
             /\ UNCHANGED <<owner, kind, partial, remotePartial, registered, everRegistered, notified,
                            reason, firstReason, notifiedReason, decoderStopped, lateRead, unownedNotification>>
ReplaceCause == /\ owner = "input" /\ Fault = "overwrite" /\ reason' = "different"
                /\ UNCHANGED <<owner, kind, partial, remotePartial, registered, everRegistered, notified,
                               firstReason, notifiedReason, decoderStopped, finishes, lateRead, unownedNotification>>
LateRead == /\ owner # "open" /\ Fault = "late" /\ lateRead' = TRUE
            /\ UNCHANGED <<owner, kind, partial, remotePartial, registered, everRegistered, notified,
                           reason, firstReason, notifiedReason, decoderStopped, finishes, unownedNotification>>
Next == Begin \/ Boundary \/ Register \/ (\E cause \in {"error", "abort"}: Retire(cause))
        \/ RemoteEnd \/ DetachCore \/ UnlistenInput \/ RepeatEnd \/ ReplaceCause \/ LateRead
Spec == Init /\ [][Next]_vars
PreserveInputCause == owner = "input" => reason = firstReason
RemoteTruncation == (owner = "input" /\ kind = "remote") => reason = IF remotePartial THEN "truncation" ELSE "original"
FinishAtMostOnce == finishes <= 1
RetirementStopsDecoder == owner # "open" => decoderStopped
NoSyntheticLeak == reason # "synthetic" /\ notifiedReason # "synthetic"
NotificationOwnsCause == ~unownedNotification
ReplayInstalled == (owner = "input" /\ registered) => notified
NoDecoderReadAfterTerminal == ~lateRead
=============================================================================
