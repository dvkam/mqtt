-------------------------- MODULE PublicationAdmission --------------------------
\* Rule: Pending publications stay within the item and byte limits. A reservation is held until its write settled,
\* also after retirement. A control packet needs no publication slot.
\* Source: src/publicationAdmission.ts (PublicationAdmission, reserve)
\* Source: src/portable.ts (publish, fail)
\* Source: src/qosZeroWrites.ts (QosZeroWrites, run, retire)
\* Tests: test/outgoing-admission.test.ts
\* Mapping: Reserve is reserve in publish. Complete is the release function that run calls when the write settles.
\* Retire is fail, where retire rejects the callers and each reservation still returns from its own write. Control
\* is a ping or a subscription change, which never calls reserve.
\* Not modeled: The Maximum Packet Size check, the publishSize formula, the QoS 1 queue, which QosOneOutbound
\* covers, and QoS 0 writes that wait for resends.
EXTENDS Naturals, FiniteSets
CONSTANT Fault
VARIABLES held, reserved, retired, controlSent
vars == <<held, reserved, retired, controlSent>>
Items == {1, 2, 3, 4}
Bytes(items) == (IF 1 \in items THEN 1 ELSE 0) + (IF 2 \in items THEN 1 ELSE 0)
                + (IF 3 \in items THEN 1 ELSE 0) + (IF 4 \in items THEN 4 ELSE 0)
Init == /\ held = {} /\ reserved = {} /\ retired = FALSE /\ controlSent = FALSE
Reserve == \E item \in Items \ held:
  /\ ~retired
  /\ (Fault = "items" \/ Cardinality(reserved) < 2)
  /\ (Fault = "bytes" \/ Bytes(reserved \cup {item}) <= 4)
  /\ held' = held \cup {item} /\ reserved' = reserved \cup {item}
  /\ UNCHANGED <<retired, controlSent>>
Complete == \E item \in held:
  /\ held' = held \ {item} /\ reserved' = reserved \ {item}
  /\ UNCHANGED <<retired, controlSent>>
Retire == /\ ~retired /\ retired' = TRUE
          /\ reserved' = IF Fault = "release" THEN {} ELSE reserved
          /\ UNCHANGED <<held, controlSent>>
Control == /\ ~retired /\ ~controlSent
           /\ (Fault # "control" \/ Cardinality(reserved) < 2)
           /\ controlSent' = TRUE /\ UNCHANGED <<held, reserved, retired>>
Next == Reserve \/ Complete \/ Retire \/ Control
Spec == Init /\ [][Next]_vars
BoundedItems == Cardinality(reserved) <= 2
BoundedBytes == Bytes(reserved) <= 4
PendingCovered == held \subseteq reserved
ControlAvailable == (~retired /\ ~controlSent) => ENABLED Control
=============================================================================
