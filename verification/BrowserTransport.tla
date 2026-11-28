----------------------------- MODULE BrowserTransport -----------------------------
\* Rule: No message reaches the session after the transport retired. Buffered writes stay within the write budget. A
\* native close settles the writer even when the end notification throws.
\* Source: src/browserClient.ts (openBrowserSocket, message, detach, nativeClosed, closeSeen)
\* Source: src/transportCore.ts (connectOverBytes, finish, teardown)
\* Source: src/packetInput.ts (PacketInput, push)
\* Source: src/nativeWriteBudget.ts (allowsNativeWrite)
\* Tests: test/browser-core-changes.test.ts, test/browser-client.test.ts, test/browser-eof.test.ts
\* Mapping: Capture is a message event that the browser queued before retirement. Deliver is the message listener
\* calling inbound.bytes, where PacketInput.push drops input after the terminal cause. Admit is allowsNativeWrite in
\* send, measured against socket.bufferedAmount. Drain is the socket sending buffered bytes. Retire is a terminal
\* path through finish or detachCore. NativeClose is nativeClosed, whose finally block calls closeSeen after
\* inbound.end. Deadline is the timer in the writer's close.
\* Not modeled: Timer delays in a suspended page, physical socket closure, listener counts and receive size, which
\* WebSocketReceive covers.
\* The model was written for src/browserTransport.ts, which no longer exists. The browser opener and the byte core
\* now share its rules.
EXTENDS Naturals
CONSTANT Fault
VARIABLES retired, captured, queued, invalidDelivery, nativeClosed, settled, observerThrows
vars == <<retired, captured, queued, invalidDelivery, nativeClosed, settled, observerThrows>>
Init == /\ retired = FALSE
        /\ captured = FALSE
        /\ queued = 0
        /\ invalidDelivery = FALSE
        /\ nativeClosed = FALSE
        /\ settled = FALSE
        /\ observerThrows \in BOOLEAN
Capture == /\ ~retired /\ ~captured
           /\ captured' = TRUE
           /\ UNCHANGED <<retired, queued, invalidDelivery, nativeClosed, settled, observerThrows>>
Deliver == /\ captured
           /\ invalidDelivery' = (invalidDelivery \/ (retired /\ Fault = "delivery"))
           /\ captured' = FALSE
           /\ UNCHANGED <<retired, queued, nativeClosed, settled, observerThrows>>
Admit == /\ ~retired
         /\ queued < 3
         /\ (queued < 2 \/ Fault = "budget")
         /\ queued' = queued + 1
         /\ UNCHANGED <<retired, captured, invalidDelivery, nativeClosed, settled, observerThrows>>
Drain == /\ queued > 0 /\ queued' = queued - 1
         /\ UNCHANGED <<retired, captured, invalidDelivery, nativeClosed, settled, observerThrows>>
Retire == /\ ~retired /\ retired' = TRUE
          /\ UNCHANGED <<captured, queued, invalidDelivery, nativeClosed, settled, observerThrows>>
NativeClose == /\ ~nativeClosed
               /\ nativeClosed' = TRUE
               /\ retired' = TRUE
               /\ settled' = ~(observerThrows /\ Fault = "observer")
               /\ UNCHANGED <<captured, queued, invalidDelivery, observerThrows>>
Deadline == /\ retired /\ ~settled
            /\ settled' = TRUE
            /\ UNCHANGED <<retired, captured, queued, invalidDelivery, nativeClosed, observerThrows>>
Next == Capture \/ Deliver \/ Admit \/ Drain \/ Retire \/ NativeClose \/ Deadline
Spec == Init /\ [][Next]_vars
NoLateDelivery == ~invalidDelivery
BoundedAdmission == queued <= 2
NativeCloseSettles == nativeClosed => settled
=============================================================================
