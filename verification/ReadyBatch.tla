------------------------------ MODULE ReadyBatch ------------------------------
\* Rule: A batch read returns the first ready messages in order within the item and byte limits. One batch read can
\* be pending. A cancelled or failed queue returns no batch.
\* Source: test/experiments/message-queue.ts (createMessageQueue, iterateBatches, takeQueued)
\* Tests: test/batch-queue.test.ts
\* Mapping: Init is the state after the single read staged the first item. TakeReady is the while loop in
\* iterateBatches. Commit is next returning the batch. Stop is close, cancel or fail before the commit. Overlap is a
\* second next while one is reading.
\* Not modeled: Message contents and the single-item and stream views, which MessageQueueOwnership and
\* StreamTerminal cover.
\* This model covers test-only code under test/experiments. The package does not export the queue.
EXTENDS Naturals, Sequences
CONSTANT Fault
VARIABLE state
vars == <<state>>

MaxItems == 2
MaxBytes == 3
Entry(id, weight) == [id |-> id, weight |-> weight]

RECURSIVE Bytes(_)
Bytes(entries) == IF entries = <<>> THEN 0 ELSE Head(entries).weight + Bytes(Tail(entries))

Init ==
  \E firstWeight, secondWeight, thirdWeight \in 1..2, queued \in 0..2:
    LET ready == SubSeq(<<Entry(2, secondWeight), Entry(3, thirdWeight)>>, 1, queued)
    IN /\ Bytes(ready) <= MaxBytes
       /\ state = [phase |-> "open", staged |-> Entry(1, firstWeight), queue |-> ready,
                    readers |-> 1, settled |-> FALSE, output |-> <<>>]

Stop(kind) ==
  /\ ~state.settled
  /\ state.phase = "open" \/ (state.phase = "closing" /\ kind = "cancelled")
  /\ state' = [state EXCEPT !.phase = kind, !.queue = IF kind = "closing" THEN @ ELSE <<>>]

Overlap ==
  /\ Fault = "overlap"
  /\ ~state.settled /\ state.readers = 1
  /\ state' = [state EXCEPT !.readers = 2]

TakeReady ==
  LET staged == <<state.staged>>
      ready == state.queue
  IN IF Fault = "items" /\ Len(ready) = 2 /\ Bytes(staged \o ready) <= MaxBytes
     THEN staged \o ready
     ELSE IF Fault = "skip" /\ Len(ready) = 2 /\ state.staged.weight + ready[2].weight <= MaxBytes
          THEN Append(staged, ready[2])
          ELSE IF Len(ready) > 0 /\ (state.staged.weight + Head(ready).weight <= MaxBytes \/ Fault = "bytes")
               THEN Append(staged, Head(ready))
               ELSE staged

Commit ==
  /\ ~state.settled /\ state.readers = 1
  /\ state.phase \in {"open", "closing"} \/ Fault = "terminal"
  /\ LET output == TakeReady
     IN state' = [state EXCEPT !.output = output, !.settled = TRUE, !.readers = 0,
                              !.queue = SubSeq(@, Len(output), Len(@))]

SettleStopped ==
  /\ ~state.settled /\ state.phase \in {"cancelled", "failed"}
  /\ state' = [state EXCEPT !.settled = TRUE, !.readers = 0]

Next == (\E kind \in {"closing", "cancelled", "failed"}: Stop(kind)) \/ Overlap \/ Commit \/ SettleStopped
Spec == Init /\ [][Next]_vars

BatchItemLimit == Len(state.output) <= MaxItems
BatchByteLimit == Bytes(state.output) <= MaxBytes
BatchFifo == \A position \in DOMAIN state.output: state.output[position].id = position
ReadySuffix == state.settled /\ Len(state.output) > 0 =>
  \A position \in DOMAIN state.queue: state.queue[position].id = Len(state.output) + position
SinglePendingBatch == state.readers <= 1
NoBatchAfterStop == state.phase \in {"cancelled", "failed"} => state.output = <<>>
GracefulBatch == state.phase = "closing" /\ state.settled => Len(state.output) >= 1
================================================================================
