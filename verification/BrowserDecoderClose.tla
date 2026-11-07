------------------------- MODULE BrowserDecoderClose -------------------------
EXTENDS Naturals
CONSTANT Fault
VARIABLES phase, pending, cause, outcome, completions, partialAtClose
vars == <<phase, pending, cause, outcome, completions, partialAtClose>>
Init == /\ phase = "open" /\ pending = FALSE
        /\ cause = "none" /\ outcome = "none" /\ completions = 0 /\ partialAtClose = FALSE
Begin == /\ phase = "open" /\ pending' = TRUE
         /\ UNCHANGED <<phase, cause, outcome, completions, partialAtClose>>
Complete == /\ phase = "open" /\ pending' = FALSE
            /\ UNCHANGED <<phase, cause, outcome, completions, partialAtClose>>
Retire(kind) == /\ phase = "open"
                /\ phase' = "retired" /\ cause' = kind /\ partialAtClose' = pending
                /\ outcome' = IF pending /\ Fault # "omit"
                                  /\ (kind = "remote" \/ Fault = "replace")
                               THEN "truncated" ELSE kind
                /\ completions' = 1
                /\ pending' = FALSE
Repeat == /\ phase = "retired" /\ completions < 2
          /\ completions' = IF Fault = "repeat" THEN completions + 1 ELSE completions
          /\ UNCHANGED <<phase, pending, cause, outcome, partialAtClose>>
Next == Begin \/ Complete \/ (\E kind \in {"remote", "local", "abort", "error"}: Retire(kind)) \/ Repeat
Spec == Init /\ [][Next]_vars
RemoteTruncation == (cause = "remote" /\ partialAtClose) => outcome = "truncated"
PreserveOtherCause == cause \in {"none", "remote"} \/ outcome = cause
FinishAtMostOnce == completions <= 1
=============================================================================
