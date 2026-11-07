----------------------------- MODULE CodecFrames -----------------------------
EXTENDS Naturals
CONSTANT Fault
VARIABLES phase, allocated, received, emittedEarly, emittedAfterFailure
vars == <<phase, allocated, received, emittedEarly, emittedAfterFailure>>
Init == /\ phase = "header"
        /\ allocated = 0
        /\ received = 0
        /\ emittedEarly = FALSE
        /\ emittedAfterFailure = FALSE
Declare == /\ phase = "header"
           /\ \E total \in 2..5:
                 /\ IF total <= 3 \/ Fault = "allocation"
                    THEN /\ phase' = "body" /\ allocated' = total /\ received' = 2
                    ELSE /\ phase' = "failed" /\ allocated' = 0 /\ received' = 0
                 /\ UNCHANGED <<emittedEarly, emittedAfterFailure>>
Copy == /\ phase = "body" /\ received < allocated
        /\ received' = received + 1
        /\ UNCHANGED <<phase, allocated, emittedEarly, emittedAfterFailure>>
Emit == /\ phase = "body"
        /\ (received = allocated \/ Fault = "early")
        /\ emittedEarly' = (emittedEarly \/ received # allocated)
        /\ phase' = "header" /\ allocated' = 0 /\ received' = 0
        /\ UNCHANGED emittedAfterFailure
Reject == /\ phase # "failed"
          /\ phase' = "failed" /\ allocated' = 0 /\ received' = 0
          /\ UNCHANGED <<emittedEarly, emittedAfterFailure>>
FailedInput == /\ phase = "failed"
               /\ emittedAfterFailure' = (emittedAfterFailure \/ Fault = "poison")
               /\ UNCHANGED <<phase, allocated, received, emittedEarly>>
Next == Declare \/ Copy \/ Emit \/ Reject \/ FailedInput
Spec == Init /\ [][Next]_vars
BoundedAllocation == allocated <= 3
CompleteBeforeEmit == ~emittedEarly
NoOutputAfterFailure == ~emittedAfterFailure
=============================================================================
