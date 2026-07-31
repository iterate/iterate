# M5StickS3 direct-LAN 60-second physical playback proof

This is the first endurance rung after the hardware-descriptor reserve fix and
the acoustic analyzer's coherent-boundary-leakage regression.

Subject identity checked immediately before the run:

- USB serial / ESP MAC: `70:04:1D:D5:45:88`
- port at run start: `/dev/cu.usbmodem11201`
- VID:PID: `303a:1001`
- USB location: `1-1.2`

The command reuses the already-flashed configuration and binds the host PCM
server directly on `192.168.0.169:58685`. The raw CoreAudio capture, complete
terminal transcript, digital counters, memory, CPU, queue depths, and acoustic
assessment are retained in this directory.
