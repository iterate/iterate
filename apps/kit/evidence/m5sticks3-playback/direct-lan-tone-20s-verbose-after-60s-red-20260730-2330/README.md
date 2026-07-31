# M5StickS3 20-second verbose reproduction after the 60-second red run

This diagnostic repetition keeps the same direct-LAN path, firmware, acoustic
capture, and strict zero-incident policy as the failed 60-second rung. It adds
only host-side logging of the already-subscribed one-second metrics callbacks,
so the first diverging queue, timing, memory, CPU, or counter sample is retained
if the underrun repeats.

Subject identity checked immediately before the run:

- USB serial / ESP MAC: `70:04:1D:D5:45:88`
- port: `/dev/cu.usbmodem11201`
- VID:PID: `303a:1001`
- USB location: `1-1.2`
