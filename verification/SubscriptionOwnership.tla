-------------------------- MODULE SubscriptionOwnership --------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Fault
VARIABLES owner, started, held, sent, acked, released, cleaned, cost, identifierOf, retired, terminalStarted, wrong
vars == <<owner, started, held, sent, acked, released, cleaned, cost, identifierOf, retired, terminalStarted, wrong>>
Ids == {1, 2, 3}
Leases == {1, 2, 3}
Occupied == {identifier \in Ids : owner[identifier] # 0}
Owners == {owner[identifier] : identifier \in Occupied}
Bytes == (IF 1 \in Owners THEN cost[1] ELSE 0)
       + (IF 2 \in Owners THEN cost[2] ELSE 0)
       + (IF 3 \in Owners THEN cost[3] ELSE 0)
Init == /\ owner = [identifier \in Ids |-> 0]
        /\ started = {} /\ held = {} /\ sent = {} /\ acked = {}
        /\ released = {} /\ cleaned = {} /\ cost = [lease \in Leases |-> 1]
        /\ identifierOf = [lease \in Leases |-> 1]
        /\ retired = FALSE /\ terminalStarted = {} /\ wrong = FALSE
Reserve == \E lease \in Leases \ started, identifier \in Ids, charge \in {1, 3}:
  /\ (~retired \/ Fault = "retired")
  /\ (owner[identifier] = 0 \/ Fault = "reuse")
  /\ (Cardinality(Occupied) < 2 \/ Fault = "items")
  /\ (Bytes + charge <= 3 \/ Fault = "bytes")
  /\ owner' = [owner EXCEPT ![identifier] = lease]
  /\ started' = started \cup {lease} /\ held' = held \cup {lease}
  /\ cost' = [cost EXCEPT ![lease] = charge]
  /\ identifierOf' = [identifierOf EXCEPT ![lease] = identifier]
  /\ UNCHANGED <<sent, acked, released, cleaned, retired, terminalStarted, wrong>>
Send == \E lease \in started \ sent:
  /\ sent' = sent \cup {lease}
  /\ UNCHANGED <<owner, started, held, acked, released, cleaned, cost, identifierOf, retired, terminalStarted, wrong>>
Ack == \E lease \in held \ acked, kind \in {"suback", "other"}:
  /\ ~retired /\ (kind = "suback" \/ Fault = "kind")
  /\ acked' = acked \cup {lease}
  /\ wrong' = (wrong \/ kind # "suback")
  /\ UNCHANGED <<owner, started, held, sent, released, cleaned, cost, identifierOf, retired, terminalStarted>>
Release == \E lease \in held:
  /\ ~retired /\ lease \in acked
  /\ (lease \in sent \/ Fault = "early")
  /\ owner' = [identifier \in Ids |-> IF owner[identifier] = lease THEN 0 ELSE owner[identifier]]
  /\ held' = held \ {lease} /\ released' = released \cup {lease}
  /\ UNCHANGED <<started, sent, acked, cleaned, cost, identifierOf, retired, terminalStarted, wrong>>
OldCleanup == \E lease \in released \ cleaned:
  /\ cleaned' = cleaned \cup {lease}
  /\ owner' = IF Fault = "stale" THEN [owner EXCEPT ![identifierOf[lease]] = 0] ELSE owner
  /\ UNCHANGED <<started, held, sent, acked, released, cost, identifierOf, retired, terminalStarted, wrong>>
Retire == /\ ~retired /\ retired' = TRUE /\ terminalStarted' = started
          /\ owner' = [identifier \in Ids |-> 0]
          /\ UNCHANGED <<started, held, sent, acked, released, cleaned, cost, identifierOf, wrong>>
Next == Reserve \/ Send \/ Ack \/ Release \/ OldCleanup \/ Retire
Spec == Init /\ [][Next]_vars
BoundedItems == Cardinality(Occupied) <= 2
BoundedBytes == Bytes <= 3
OwnedUntilComplete == retired \/ held \subseteq Owners
NoEarlyRelease == released \subseteq (sent \cap acked)
NoWrongKind == ~wrong
NoAdmissionAfterRetirement == ~retired \/ started = terminalStarted
=============================================================================
