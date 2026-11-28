------------------------- MODULE BrowserDecoderClose -------------------------
\* Rule: A remote close inside a packet ends the input with a truncation error. A local close, an abort and a
\* transport error keep their own cause. The input ends once.
\* Source: src/browserClient.ts (openBrowserSocket, nativeClosed)
\* Source: src/transportCore.ts (connectOverBytes, abort)
\* Source: src/packetInput.ts (PacketInput, remoteEnd, retire, detachCore)
\* Source: src/packetFramer.ts (PacketFramer, finish)
\* Tests: test/browser-eof.test.ts, test/node-packet-input.test.ts
\* Mapping: Begin and Complete are PacketFramer.push entering and leaving a partial packet. Retire("remote") is
\* nativeClosed calling inbound.end, which reaches remoteEnd, where finish throws for a partial packet.
\* Retire("abort") and Retire("error") are retire. Retire("local") is detachCore. Repeat is the terminal guard at
\* the start of each of those methods.
\* Not modeled: Packet contents, listener replay and the internal detach reason, which NodeInputLifecycle covers for
\* the same class.
\* The model was written for src/browserTransport.ts, which no longer exists. PacketInput now owns this rule for
\* every transport.
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
