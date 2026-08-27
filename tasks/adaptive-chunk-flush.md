---
status: needs-grilling
size: medium
---

# Adaptive-window decoupling for agent chunk journaling

Follow-up to #2531. The coalesced `llm-response-chunks` flush is still awaited
inside `onChunk`, so the transport drain still shares fate with the stream DO
(`window/(window + append latency)` of provider rate). Chunk events are
forcibly ephemeral — a lane allowed to lose data must not be allowed to slow
the producer. Fire the flush without awaiting, in-flight cap of one, merge
subsequent windows into the growing buffer while an append is pending: journal
degradation coarsens UI granularity instead of throttling delivery.

Being fleshed out via grill-you; spec lands here before implementation.
