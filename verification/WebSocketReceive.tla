--------------------------- MODULE WebSocketReceive ---------------------------
\* Rule: A browser WebSocket message above maxWebSocketMessageBytes never reaches the framer and retires the
\* session. No message is delivered after retirement.
\* Source: src/browserClient.ts (openBrowserSocket, message, detach, maxWebSocketMessageBytes)
\* Source: src/websocketLimits.ts (resolveWebSocketMessageLimit)
\* Source: src/transportCore.ts (connectOverBytes, finish)
\* Source: src/packetInput.ts (PacketInput, push, retire)
\* Tests: test/browser-receive-limit.test.ts
\* Mapping: Capture is a message event that the browser queued before retirement. Deliver is the message listener.
\* It compares byteLength with the limit before it builds a Uint8Array. A larger message goes to inbound.fail, which
\* retires the input. An admitted message goes to inbound.bytes, where PacketInput.push drops it after the terminal
\* cause. Retire is any terminal path, after which detach removes the listener.
\* Not modeled: Empty and text messages, option validation, and the ws limit on Node, which NodeReceive covers.
\* The model was written for src/browserTransport.ts, which no longer exists. The browser opener now owns the size
\* check and PacketInput the retirement guard.
EXTENDS Naturals
CONSTANT Fault
VARIABLES retired, capturedSize, excessAdmitted, lateAdmitted
vars == <<retired, capturedSize, excessAdmitted, lateAdmitted>>
Init == /\ retired = FALSE /\ capturedSize = 0
        /\ excessAdmitted = FALSE /\ lateAdmitted = FALSE
Capture == /\ ~retired /\ capturedSize = 0 /\ capturedSize' \in 1..3
           /\ UNCHANGED <<retired, excessAdmitted, lateAdmitted>>
Deliver == /\ capturedSize > 0
           /\ excessAdmitted' = (excessAdmitted \/ (~retired /\ capturedSize > 2 /\ Fault = "budget"))
           /\ lateAdmitted' = (lateAdmitted \/ (retired /\ capturedSize <= 2 /\ Fault = "late"))
           /\ retired' = (retired \/ (capturedSize > 2 /\ Fault # "budget"))
           /\ capturedSize' = 0
Retire == /\ ~retired /\ retired' = TRUE
          /\ UNCHANGED <<capturedSize, excessAdmitted, lateAdmitted>>
Next == Capture \/ Deliver \/ Retire
Spec == Init /\ [][Next]_vars
BoundedReceive == ~excessAdmitted
NoLateReceive == ~lateAdmitted
=============================================================================
