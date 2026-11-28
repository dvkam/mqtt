------------------------- MODULE AckPropertyLayout -------------------------
\* Rule: A PUBACK with a Remaining Length of 2 or 3 has no property section and is accepted. Every other
\* acknowledgment has its property section checked before the packet leaves the decoder.
\* Source: src/wireCodec.ts (decodeBody, Reader)
\* Source: src/wireProperties.ts (readProperties)
\* Tests: test/ack-property-strings.test.ts
\* Mapping: Family "confirmation" is PUBACK. Family "subscription" is SUBACK or UNSUBACK, where a body of 2 bytes
\* has no Property Length and is malformed. Inspect is the reader.remaining test in decodeBody. Validate is
\* readProperties. Dispatch is decodeBody returning the packet.
\* Not modeled: Reason codes, property contents, and PUBREC, PUBREL and PUBCOMP, which use the same branch as
\* PUBACK.
EXTENDS Naturals
CONSTANT Fault
VARIABLES phase, family, bodyLength, propertyValid, checked, delivered
vars == <<phase, family, bodyLength, propertyValid, checked, delivered>>

Init == /\ phase = "framed"
        /\ family \in {"confirmation", "subscription"}
        /\ bodyLength \in {2, 3, 4}
        /\ propertyValid \in IF family = "confirmation" /\ bodyLength < 4 THEN {TRUE}
                              ELSE IF family = "subscription" /\ bodyLength = 2 THEN {FALSE}
                              ELSE {TRUE, FALSE}
        /\ checked = FALSE /\ delivered = FALSE

NeedsValidation == family = "subscription" \/ bodyLength > 3

Inspect == /\ phase = "framed"
           /\ phase' = IF Fault = "skip"
                          \/ (Fault = "subscriptionShort" /\ family = "subscription" /\ bodyLength < 4)
                        THEN "ready"
                        ELSE IF NeedsValidation \/ Fault = "require" THEN "checking" ELSE "ready"
           /\ UNCHANGED <<family, bodyLength, propertyValid, checked, delivered>>

Validate == /\ phase = "checking"
            /\ checked' = TRUE
            /\ phase' = IF propertyValid /\ NeedsValidation THEN "ready" ELSE "failed"
            /\ UNCHANGED <<family, bodyLength, propertyValid, delivered>>

Dispatch == /\ phase = "ready"
            /\ delivered' = TRUE /\ phase' = "dispatched"
            /\ UNCHANGED <<family, bodyLength, propertyValid, checked>>

Next == Inspect \/ Validate \/ Dispatch
Spec == Init /\ [][Next]_vars
PropertiesCheckedBeforeDispatch == (delivered /\ NeedsValidation) => checked
MalformedPropertiesNeverDispatch == delivered => propertyValid
CompactFormsAccepted == (family = "confirmation" /\ bodyLength < 4) => phase # "failed"
=============================================================================
