----------------------------- MODULE NodePublishTopic -------------------------
\* Rule: A PUBLISH whose Topic Name is truncated, is not UTF-8 or contains U+0000 is rejected before delivery.
\* Source: src/wireCodec.ts (Reader, publishTopic, decodeBody)
\* Source: src/wireProperties.ts (decodeUtf8)
\* Tests: test/inbound-publish-topic.test.ts
\* Mapping: Complete is publishTopic. Dispatch is the decoded packet leaving the decoder.
\* Not modeled: An empty topic, wildcard characters and Topic Alias, which validateInboundTopic in
\* src/inboundTopic.ts checks.
CONSTANT Fault
VARIABLES phase, shape, delivered
vars == <<phase, shape, delivered>>

Init == /\ phase = "partial"
        /\ shape \in {"valid", "badUtf8", "nul", "truncated"}
        /\ delivered = FALSE

Complete == /\ phase = "partial"
            /\ phase' = IF shape = "valid" \/ Fault = "skip" THEN "ready" ELSE "failed"
            /\ UNCHANGED <<shape, delivered>>

Dispatch == /\ phase = "ready"
            /\ phase' = "dispatched" /\ delivered' = TRUE
            /\ UNCHANGED shape

Next == Complete \/ Dispatch
Spec == Init /\ [][Next]_vars
ValidateBeforeDelivery == delivered => shape = "valid"
===============================================================================
