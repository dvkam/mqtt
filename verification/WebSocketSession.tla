----------------------------- MODULE WebSocketSession -----------------------------
\* Rule: The session delivers a QoS 0 message only after it accepted CONNACK and before it closed. Writes are
\* admitted only within the write budget.
\* Source: src/portable.ts (PortableClient, receiveConnack, activation, fail)
\* Source: src/transportCore.ts (connectOverBytes, send)
\* Source: src/nativeWriteBudget.ts (allowsNativeWrite)
\* Tests: test/websocket-client.test.ts, test/browser-client.test.ts, test/portable.test.ts
\* Mapping: Accept is receiveConnack setting activation to accepted. Deliver is the onMessage call in the
\* constructor's packet listener, behind its failure, closing and activation guards. Admit is allowsNativeWrite in
\* send, which adds the packet's wire bytes to bufferedBytes. Drain is the socket sending buffered bytes. Close is
\* fail or disconnect.
\* Not modeled: Frame overhead, parser allocations, kernel buffers and the control reserve, which NativeWriteReserve
\* covers.
\* The name predates the shared byte core. Every byte transport uses this path.
EXTENDS Naturals

CONSTANT Fault
VARIABLES phase, queued, invalidDelivery
vars == <<phase, queued, invalidDelivery>>

Init == /\ phase = "awaiting"
        /\ queued = 0
        /\ invalidDelivery = FALSE

Accept == /\ phase = "awaiting"
          /\ phase' = "active"
          /\ UNCHANGED <<queued, invalidDelivery>>

Deliver == /\ (phase = "active" \/ Fault = "deliver")
           /\ invalidDelivery' = (invalidDelivery \/ phase # "active")
           /\ UNCHANGED <<phase, queued>>

Admit == /\ phase = "active"
         /\ (queued < 2 \/ Fault = "budget")
         /\ queued < 3
         /\ queued' = queued + 1
         /\ UNCHANGED <<phase, invalidDelivery>>

Drain == /\ queued > 0
         /\ queued' = queued - 1
         /\ UNCHANGED <<phase, invalidDelivery>>

Close == /\ phase # "closed"
         /\ phase' = "closed"
         /\ queued' = 0
         /\ UNCHANGED invalidDelivery

Next == Accept \/ Deliver \/ Admit \/ Drain \/ Close
Spec == Init /\ [][Next]_vars
NoInvalidDelivery == ~invalidDelivery
BoundedBudget == queued <= 2
=============================================================================
