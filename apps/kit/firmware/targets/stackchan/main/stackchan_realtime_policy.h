#ifndef ITERATE_KIT_STACKCHAN_REALTIME_POLICY_H
#define ITERATE_KIT_STACKCHAN_REALTIME_POLICY_H

/*
 * These are StackChan's target-level realtime choices, not properties of the
 * CoreS3 codec driver. Keeping them outside main.c lets the host clock harness
 * exercise the exact policy flashed onto the board. That matters here because
 * a freshness value can look safely bounded in isolation while contradicting
 * userspace's finite startup lead and deterministically clipping every reply.
 */
/*
 * Userspace primes eight 20 ms frames (160 ms) so a provider packet gap does
 * not become a speaker underrun. A 120 ms limit deterministically discarded
 * the tail of that valid burst before hardware could consume it. The 400 ms
 * bound is the already-proven Stick policy: enough for finite startup lead and
 * ordinary scheduling jitter, while generation fences still prevent outage
 * audio from ever being replayed as current conversation.
 */
#define STACKCHAN_MAXIMUM_DOWNLINK_FRAME_AGE_MS 400U

#endif
