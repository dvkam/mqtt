------------------------- MODULE NodePacketAdmission -------------------------
EXTENDS Naturals
CONSTANT Fault
VARIABLES mode, phase, admitted, allocated, copied, decoded, earlyDecode,
          lateInput, stopRequested, truncatedCompletion
vars == <<mode, phase, admitted, allocated, copied, decoded, earlyDecode,
          lateInput, stopRequested, truncatedCompletion>>
Init == /\ mode \in {"compact", "streaming"}
        /\ phase = "boundary" /\ admitted = 0 /\ allocated = 0 /\ copied = 0
        /\ decoded = 0 /\ earlyDecode = FALSE /\ lateInput = FALSE
        /\ stopRequested = FALSE /\ truncatedCompletion = FALSE
Header == /\ phase = "boundary" /\ decoded < 2 /\ phase' = "length"
          /\ UNCHANGED <<mode, admitted, allocated, copied, decoded, earlyDecode,
                         lateInput, stopRequested, truncatedCompletion>>
Declare(size) == /\ phase = "length"
                 /\ phase' = IF size <= 3 \/ Fault = "budget" THEN "body" ELSE "failed"
                 /\ admitted' = IF size <= 3 \/ Fault = "budget" THEN size ELSE 0
                 /\ allocated' = IF mode = "compact" /\ (size <= 3 \/ Fault = "budget") THEN size - 1 ELSE 0
                 /\ copied' = 0
                 /\ UNCHANGED <<mode, decoded, earlyDecode, lateInput, stopRequested, truncatedCompletion>>
Copy == /\ phase = "body" /\ copied < admitted - 2 /\ copied' = copied + 1
        /\ UNCHANGED <<mode, phase, admitted, allocated, decoded, earlyDecode,
                       lateInput, stopRequested, truncatedCompletion>>
Decode == /\ phase = "body" /\ decoded < 2
        /\ (copied = admitted - 2 \/ Fault = "early")
        /\ phase' = "callback" /\ decoded' = decoded + 1 /\ allocated' = 0
        /\ earlyDecode' = (earlyDecode \/ copied < admitted - 2)
        /\ UNCHANGED <<mode, admitted, copied, lateInput, stopRequested, truncatedCompletion>>
Resume == /\ phase = "callback" /\ phase' = "boundary" /\ admitted' = 0 /\ copied' = 0
          /\ UNCHANGED <<mode, allocated, decoded, earlyDecode, lateInput, stopRequested, truncatedCompletion>>
Stop == /\ phase \in {"boundary", "length", "body", "callback"} /\ ~stopRequested
        /\ stopRequested' = TRUE /\ phase' = IF Fault = "retire" THEN "boundary" ELSE "failed"
        /\ admitted' = 0 /\ allocated' = 0 /\ copied' = 0
        /\ UNCHANGED <<mode, decoded, earlyDecode, lateInput, truncatedCompletion>>
Reject == /\ phase \in {"boundary", "length", "body", "callback"}
          /\ phase' = "failed" /\ admitted' = 0 /\ allocated' = 0 /\ copied' = 0
          /\ UNCHANGED <<mode, decoded, earlyDecode, lateInput, stopRequested, truncatedCompletion>>
Finish == /\ phase \in {"boundary", "length", "body"}
          /\ phase' = IF phase = "boundary" \/ Fault = "eof" THEN "ended" ELSE "failed"
          /\ truncatedCompletion' = (phase # "boundary" /\ Fault = "eof")
          /\ admitted' = 0 /\ allocated' = 0 /\ copied' = 0
          /\ UNCHANGED <<mode, decoded, earlyDecode, lateInput, stopRequested>>
InputAfterFailure == /\ phase = "failed" /\ Fault = "poison" /\ lateInput' = TRUE
                     /\ UNCHANGED <<mode, phase, admitted, allocated, copied, decoded,
                                    earlyDecode, stopRequested, truncatedCompletion>>
Next == Header \/ (\E size \in 2..4: Declare(size)) \/ Copy \/ Decode \/ Resume
        \/ Stop \/ Reject \/ Finish \/ InputAfterFailure
Spec == Init /\ [][Next]_vars
BoundedPacketAdmission == admitted <= 3 /\ allocated <= 2
CompleteBeforeDecode == ~earlyDecode
PermanentFailure == ~lateInput
RetirementFenced == stopRequested => phase = "failed"
RejectTruncatedCompletion == ~truncatedCompletion
=============================================================================
