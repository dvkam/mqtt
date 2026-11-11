---------------------- MODULE DisconnectPropertyLayout ----------------------
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
