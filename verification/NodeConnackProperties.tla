----------------------- MODULE NodeConnackProperties -----------------------
\* Rule: The property walk never reads past the Property Length, and a CONNACK or PUBLISH with an ill-formed
\* property section is rejected before delivery.
\* Source: src/wireProperties.ts (readProperties, Section, need, decodeUtf8)
\* Source: src/wireCodec.ts (decodeBody)
\* Tests: test/connack-property-strings.test.ts, test/publish-property-strings.test.ts
\* Mapping: Read is a Section read, which need bounds by the end of the section. HasPayload = TRUE is a PUBLISH,
\* whose packet continues after the section. The shapes are invalid UTF-8, U+0000, a truncated section, an
\* identifier that the packet type does not allow, and a variable byte integer that is not canonical. Complete is
\* readProperties returning. Dispatch is the decoded packet leaving the decoder. The NodePublishProperties
\* configurations run this module with HasPayload = TRUE.
\* Not modeled: Repeated properties and scalar ranges, which PropertyCardinalityValues covers.
EXTENDS Naturals
CONSTANT Fault, HasPayload
VARIABLES phase, shape, cursor, propertyEnd, frameEnd, reads, delivered
vars == <<phase, shape, cursor, propertyEnd, frameEnd, reads, delivered>>

Init == /\ phase = "walking"
        /\ shape \in {"valid", "badUtf8", "nul", "truncated", "badIdentifier", "noncanonical"}
        /\ cursor = 0
        /\ propertyEnd = IF shape = "truncated" THEN 1 ELSE 2
        /\ frameEnd = IF HasPayload THEN propertyEnd + 1 ELSE propertyEnd
        /\ reads = 0
        /\ delivered = FALSE

Read == /\ phase = "walking" /\ reads < 2
        /\ IF cursor + 1 <= propertyEnd \/ Fault = "bounds"
              \/ (Fault = "payload" /\ cursor + 1 <= frameEnd)
              THEN /\ cursor' = cursor + 1 /\ reads' = reads + 1 /\ phase' = phase
              ELSE /\ phase' = "failed" /\ UNCHANGED <<cursor, reads>>
        /\ UNCHANGED <<shape, propertyEnd, frameEnd, delivered>>

Accepted == shape = "valid"
            \/ (Fault = "string" /\ shape \in {"badUtf8", "nul"})
            \/ (Fault = "bounds" /\ shape = "truncated")
            \/ (Fault = "identifier" /\ shape = "badIdentifier")
            \/ (Fault = "canonical" /\ shape = "noncanonical")

Complete == /\ phase = "walking" /\ reads = 2
            /\ phase' = IF Accepted THEN "ready" ELSE "failed"
            /\ UNCHANGED <<shape, cursor, propertyEnd, frameEnd, reads, delivered>>

Dispatch == /\ phase = "ready"
            /\ phase' = "dispatched"
            /\ delivered' = TRUE
            /\ UNCHANGED <<shape, cursor, propertyEnd, frameEnd, reads>>

Next == Read \/ Complete \/ Dispatch
Spec == Init /\ [][Next]_vars
BoundedCursor == cursor <= propertyEnd
ValidateBeforeDelivery == delivered => shape = "valid"
=============================================================================
