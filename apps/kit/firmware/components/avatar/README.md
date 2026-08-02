# PCM-clocked avatar core

This component is the allocation-free, platform-independent part of the
StackChan talking head. It consumes PCM that has actually completed speaker
DMA, produces a compact semantic pose, and renders one of four 160×120 RGB565
sprite atlases into caller-owned memory. It owns no task, queue, display,
network connection, or framebuffer.

That boundary is deliberate. Network arrival is not playout: animating from a
WebSocket callback makes the mouth lead whenever the speaker buffer grows.
Conversely, allowing the renderer to retain audio creates the same accumulating
delay that the voice pipeline is designed to destroy. A board platform may
drop visual observations and jump to the newest physical playout frame, but it
must never delay audio to preserve animation continuity.

The engine and four generated atlases were extracted from the measured
StackChan prototype in
`~/src/github.com/iterate/stackchan/experiments/02-minimal-realtime-aec/firmware-ws`.
The generated atlas headers record their CC0 1.0 dedication for the generator's
contribution. Their source packs describe the images as project-generated,
AI-assisted original artwork; no third-party game artwork is included here.

The renderer snapshot is intentionally a one-shot operation. A display task
may share a core with a lower-priority analyzer, so spinning on an in-progress
seqlock can deadlock the writer it preempted. On a race, the caller retains its
last good pose and tries on the next display tick.
