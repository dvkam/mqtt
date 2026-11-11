--------------------------- MODULE ConnackAgreement ---------------------------
CONSTANT Fault
VARIABLES requested, options, wire, phase, invalidAccepted, delivered, authSeen
vars == <<requested, options, wire, phase, invalidAccepted, delivered, authSeen>>
Init == /\ requested \in {"empty", "named"} /\ options = requested /\ wire = "none"
        /\ phase = "registered" /\ invalidAccepted = FALSE
        /\ delivered = FALSE /\ authSeen = FALSE
MutateOptions == /\ phase = "registered" /\ options # "changed" /\ options' = "changed"
                 /\ UNCHANGED <<requested, wire, phase, invalidAccepted, delivered, authSeen>>
Send == /\ phase = "registered" /\ phase' = "waiting"
        /\ wire' = IF Fault = "snapshot" THEN options ELSE requested
        /\ UNCHANGED <<requested, options, invalidAccepted, delivered, authSeen>>
AssignedValid(assigned) == IF wire = "empty" THEN assigned \in {"named", "other"}
                          ELSE assigned \in {"missing", wire}
Receive(method, data, assigned) ==
  /\ phase = "waiting"
  /\ LET valid == ~method /\ ~data /\ AssignedValid(assigned)
         allowed == (~method \/ Fault = "method") /\ (~data \/ Fault = "data")
                    /\ (AssignedValid(assigned) \/ Fault = "assignment")
     IN /\ phase' = IF allowed \/ Fault = "late" THEN "accepted" ELSE "failed"
        /\ invalidAccepted' = (~valid /\ (allowed \/ Fault = "late"))
  /\ UNCHANGED <<requested, options, wire, delivered, authSeen>>
Refuse == /\ phase = "waiting" /\ phase' = "failed"
          /\ UNCHANGED <<requested, options, wire, invalidAccepted, delivered, authSeen>>
Auth == /\ phase \in {"waiting", "accepted", "active"} /\ ~authSeen /\ authSeen' = TRUE
        /\ phase' = IF Fault = "auth" THEN phase ELSE "failed"
        /\ UNCHANGED <<requested, options, wire, invalidAccepted, delivered>>
Activate == /\ phase = "accepted" /\ phase' = "active"
            /\ UNCHANGED <<requested, options, wire, invalidAccepted, delivered, authSeen>>
Deliver == /\ phase = "active" /\ ~delivered /\ delivered' = TRUE
           /\ UNCHANGED <<requested, options, wire, phase, invalidAccepted, authSeen>>
Next == MutateOptions \/ Send \/ Refuse \/ Auth \/ Activate \/ Deliver
        \/ (\E method, data \in BOOLEAN, assigned \in {"missing", "empty", "named", "other"}: Receive(method, data, assigned))
Spec == Init /\ [][Next]_vars
CapturedIdentitySent == wire # "none" => wire = requested
ValidateBeforeAcceptance == ~invalidAccepted
UnsolicitedAuthRetires == authSeen => phase = "failed"
=============================================================================
