--------------------------- MODULE NodeCancellation ---------------------------
EXTENDS Naturals
CONSTANT Fault
VARIABLES phase, attached, cancelled, retired, sent
vars == <<phase, attached, cancelled, retired, sent>>
Init == /\ phase = "opening" /\ attached = TRUE /\ cancelled = FALSE
        /\ retired = FALSE /\ sent = 0
Transfer == /\ phase = "opening" /\ ~cancelled /\ ~retired
            /\ phase' = "active" /\ attached' = (Fault # "detach")
            /\ UNCHANGED <<cancelled, retired, sent>>
Abort == /\ ~cancelled /\ cancelled' = TRUE
         /\ retired' = (retired \/ (attached /\ Fault # "notify"))
         /\ attached' = FALSE
         /\ UNCHANGED <<phase, sent>>
Send == /\ phase = "active" /\ ~retired /\ sent < 2 /\ sent' = sent + 1
        /\ UNCHANGED <<phase, attached, cancelled, retired>>
Retire == /\ phase # "closed" /\ ~retired /\ retired' = TRUE
          /\ UNCHANGED <<phase, attached, cancelled, sent>>
ReleaseRetired == /\ phase # "closed" /\ retired /\ attached /\ attached' = FALSE
                  /\ UNCHANGED <<phase, cancelled, retired, sent>>
NativeClose == /\ phase # "closed" /\ phase' = "closed" /\ retired' = TRUE
               /\ attached' = IF Fault = "cleanup" THEN attached ELSE FALSE
               /\ UNCHANGED <<cancelled, sent>>
Next == Transfer \/ Abort \/ Send \/ Retire \/ ReleaseRetired \/ NativeClose
Spec == Init /\ [][Next]_vars
ActiveOwnsSignal == (phase = "active" /\ ~cancelled /\ ~retired) => attached
AbortRetiresActive == (phase = "active" /\ cancelled) => retired
ClosedReleasesSignal == phase = "closed" => ~attached
=============================================================================
