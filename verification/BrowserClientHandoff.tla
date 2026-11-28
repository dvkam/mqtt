----------------------------- MODULE BrowserClientHandoff -----------------------------
\* Rule: An abort that arrives while the session opens never hands a session to the caller. A forced close of the
\* browser socket settles without a wait for the native close event.
\* Source: src/transportCore.ts (connectOverBytes, isAborted, forceClose)
\* Source: src/browserClient.ts (openBrowserSocket, closeSeen)
\* Tests: test/browser-client.test.ts, test/browser-core-changes.test.ts
\* Mapping: CoreReady is connectPortable resolving. Cancel is the abort listener. Transfer is the isAborted check
\* after connectPortable, which throws and closes the packet transport. Force is close(true) on the packet
\* transport, which reaches the writer through forceClose. NativeClose is the close event, which the writer's forced
\* close does not await.
\* Not modeled: Deadlines, physical socket closure, and the Node writers, which await the close event after destroy
\* or terminate.
CONSTANT Fault
VARIABLES phase, aborted, badTransfer, forcing, forceSettled
vars == <<phase, aborted, badTransfer, forcing, forceSettled>>
Init == /\ phase = "connecting" /\ aborted = FALSE
        /\ badTransfer = FALSE /\ forcing = FALSE /\ forceSettled = FALSE
CoreReady == /\ phase = "connecting" /\ ~aborted
             /\ phase' = "handoff"
             /\ UNCHANGED <<aborted, badTransfer, forcing, forceSettled>>
Cancel == /\ ~aborted /\ aborted' = TRUE
          /\ phase' = IF phase = "active" THEN "retired" ELSE phase
          /\ UNCHANGED <<badTransfer, forcing, forceSettled>>
Transfer == /\ phase = "handoff"
            /\ phase' = IF aborted /\ Fault # "handoff" THEN "retired" ELSE "active"
            /\ badTransfer' = (badTransfer \/ (aborted /\ Fault = "handoff"))
            /\ UNCHANGED <<aborted, forcing, forceSettled>>
Force == /\ phase \in {"handoff", "active"} /\ ~forcing
         /\ phase' = "retired" /\ forcing' = TRUE
         /\ forceSettled' = (Fault # "force")
         /\ UNCHANGED <<aborted, badTransfer>>
NativeClose == /\ forcing /\ ~forceSettled
               /\ forceSettled' = TRUE
               /\ UNCHANGED <<phase, aborted, badTransfer, forcing>>
Next == CoreReady \/ Cancel \/ Transfer \/ Force \/ NativeClose
Spec == Init /\ [][Next]_vars
NoCancelledTransfer == ~badTransfer
ForceWithoutNativeWait == forcing => forceSettled
=============================================================================
