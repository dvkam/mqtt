--------------------------- MODULE CodecEndOfInput ---------------------------
\* Rule: The public decoder rejects an end of input inside a packet, returns no packet after the end, and keeps an
\* earlier failure.
\* Source: src/wireCodec.ts (PacketDecoder, pushBatch, finish)
\* Tests: test/codec.test.ts
\* Mapping: Begin and Complete are pushBatch holding and finishing a partial header or frame. Finish is finish.
\* Reject is the catch in pushBatch. InputAfterEnd is pushBatch after finish. FinishAfterFailure is finish after a
\* failure.
\* Not modeled: Packet bytes, and PacketFramer.finish, which NodePacketAdmission covers.
EXTENDS Naturals
CONSTANT Fault
VARIABLES phase, pending, truncationAccepted, outputAfterEnd, hiddenFailure
vars == <<phase, pending, truncationAccepted, outputAfterEnd, hiddenFailure>>
Init == /\ phase = "open" /\ pending = "none"
        /\ truncationAccepted = FALSE /\ outputAfterEnd = FALSE /\ hiddenFailure = FALSE
Begin == /\ phase = "open" /\ pending = "none"
         /\ pending' \in {"header", "body"}
         /\ UNCHANGED <<phase, truncationAccepted, outputAfterEnd, hiddenFailure>>
Complete == /\ phase = "open" /\ pending # "none"
            /\ pending' = "none"
            /\ UNCHANGED <<phase, truncationAccepted, outputAfterEnd, hiddenFailure>>
Finish == /\ phase = "open"
          /\ phase' = IF pending = "none" \/ Fault = "truncated" THEN "ended" ELSE "failed"
          /\ truncationAccepted' = (truncationAccepted \/ (pending # "none" /\ Fault = "truncated"))
          /\ pending' = "none"
          /\ UNCHANGED <<outputAfterEnd, hiddenFailure>>
Reject == /\ phase = "open" /\ phase' = "failed" /\ pending' = "none"
          /\ UNCHANGED <<truncationAccepted, outputAfterEnd, hiddenFailure>>
InputAfterEnd == /\ phase = "ended"
                 /\ outputAfterEnd' = (outputAfterEnd \/ Fault = "after-end")
                 /\ UNCHANGED <<phase, pending, truncationAccepted, hiddenFailure>>
FinishAfterFailure == /\ phase = "failed"
                      /\ hiddenFailure' = (hiddenFailure \/ Fault = "failure")
                      /\ UNCHANGED <<phase, pending, truncationAccepted, outputAfterEnd>>
Next == Begin \/ Complete \/ Finish \/ Reject \/ InputAfterEnd \/ FinishAfterFailure
Spec == Init /\ [][Next]_vars
RejectTruncatedEnd == ~truncationAccepted
NoOutputAfterEnd == ~outputAfterEnd
PreserveFailure == ~hiddenFailure
=============================================================================
