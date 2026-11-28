---------------------- MODULE DisconnectPropertyLayout ----------------------
\* Rule: A DISCONNECT with a Remaining Length of 0 or 1 has no property section and is accepted. A longer one has
\* its property section checked before the session reads its reason.
\* Source: src/wireCodec.ts (decodeBody, Reader)
\* Source: src/wireProperties.ts (readProperties)
\* Source: src/portable.ts (PortableClient)
\* Tests: test/disconnect-property-strings.test.ts
\* Mapping: Inspect is the reader.remaining test in the DISCONNECT case of decodeBody. Validate is readProperties.
\* Interpret is the packet listener in the PortableClient constructor, which ends the session with the broker's
\* reason.
\* Not modeled: The set of valid reason codes and the property contents.
EXTENDS Naturals
CONSTANT Fault
VARIABLES phase, bodyLength, propertyValid, checked, interpreted
vars == <<phase, bodyLength, propertyValid, checked, interpreted>>

Init == /\ phase = "framed" /\ bodyLength \in {0, 1, 2}
        /\ propertyValid \in IF bodyLength < 2 THEN {TRUE} ELSE {TRUE, FALSE}
        /\ checked = FALSE /\ interpreted = FALSE

Inspect == /\ phase = "framed"
           /\ phase' = IF Fault = "skip" \/ (bodyLength < 2 /\ Fault # "require")
                        THEN "ready" ELSE "checking"
           /\ UNCHANGED <<bodyLength, propertyValid, checked, interpreted>>

Validate == /\ phase = "checking" /\ checked' = TRUE
            /\ phase' = IF propertyValid /\ bodyLength >= 2 THEN "ready" ELSE "failed"
            /\ UNCHANGED <<bodyLength, propertyValid, interpreted>>

Interpret == /\ phase = "ready" /\ interpreted' = TRUE /\ phase' = "interpreted"
             /\ UNCHANGED <<bodyLength, propertyValid, checked>>

Next == Inspect \/ Validate \/ Interpret
Spec == Init /\ [][Next]_vars
PropertiesBeforeInterpretation == (interpreted /\ bodyLength >= 2) => checked
MalformedNeverInterpreted == interpreted => propertyValid
CompactPreserved == bodyLength < 2 => phase # "failed"
=============================================================================
