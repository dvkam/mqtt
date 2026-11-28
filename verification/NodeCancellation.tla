--------------------------- MODULE NodeCancellation ---------------------------
\* Rule: An active session keeps its abort listener. An abort retires an active session. A closed connection has
\* released the listener.
\* Source: src/transportCore.ts (connectOverBytes, abort, release, finish, isAborted)
\* Tests: test/node-cancellation.test.ts
\* Mapping: Init is the state after addEventListener on the caller's signal. Transfer is connectPortable resolving
\* and the isAborted check passing. Abort is the abort listener, which releases itself, retires the input and tears
\* the transport down. Send is a write on the active session. Retire is another terminal cause. ReleaseRetired is
\* release in a forced close. NativeClose is the transport reporting its end to finish, or close settling.
\* Not modeled: The abort reason, the controller that cancels transport.open, and socket teardown in the TCP and
\* WebSocket openers.
\* The name predates the shared byte core. The browser client uses the same listener.
EXTENDS Naturals
CONSTANT Fault
VARIABLES phase, attached, cancelled, retired, sent
vars == <<phase, attached, cancelled, retired, sent>>
Init == /\ phase = "opening" /\ attached = TRUE /\ cancelled = FALSE
        /\ retired = FALSE /\ sent = 0
Transfer == /\ phase = "opening" /\ ~cancelled /\ ~retired
            /\ phase' = "active" /\ attached' = (Fault # "detach")
            /\ UNCHANGED <<cancelled, retired, sent>>
Abort == /\ ~cancelled /\ cancelled' = TRUE
         /\ retired' = (retired \/ (attached /\ Fault # "notify"))
         /\ attached' = FALSE
         /\ UNCHANGED <<phase, sent>>
Send == /\ phase = "active" /\ ~retired /\ sent < 2 /\ sent' = sent + 1
        /\ UNCHANGED <<phase, attached, cancelled, retired>>
Retire == /\ phase # "closed" /\ ~retired /\ retired' = TRUE
          /\ UNCHANGED <<phase, attached, cancelled, sent>>
ReleaseRetired == /\ phase # "closed" /\ retired /\ attached /\ attached' = FALSE
                  /\ UNCHANGED <<phase, cancelled, retired, sent>>
NativeClose == /\ phase # "closed" /\ phase' = "closed" /\ retired' = TRUE
               /\ attached' = IF Fault = "cleanup" THEN attached ELSE FALSE
               /\ UNCHANGED <<cancelled, sent>>
Next == Transfer \/ Abort \/ Send \/ Retire \/ ReleaseRetired \/ NativeClose
Spec == Init /\ [][Next]_vars
ActiveOwnsSignal == (phase = "active" /\ ~cancelled /\ ~retired) => attached
AbortRetiresActive == (phase = "active" /\ cancelled) => retired
ClosedReleasesSignal == phase = "closed" => ~attached
=============================================================================
