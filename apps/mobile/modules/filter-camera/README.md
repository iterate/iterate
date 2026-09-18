# iPhone filter camera

Local Expo module. AVFoundation supplies camera/microphone samples; Apple's
Vision framework supplies named face rings. JavaScriptCore runs the bundled
filter logic against the small drawing surface in `FilterCanvas.swift`.
CoreGraphics renders into a four-buffer pixel pool. The preview and H.264/AAC
MP4 writer consume those same pixels. Only the resulting file URL crosses
to React Native; photos use the existing JPEG attachment contract.

Capture, drawing, tracking, and writer state share one serial queue. The
recorder writes incrementally. Encoder backpressure drops video frames and
reports their count; audio write failure stops capture with a visible error.
Closing the camera cancels its writer and deletes the unfinished file. New
commands wait for camera pixels and required images (30-second deadline).
Images download to files, decode at up to 1024 pixels, and use a 32 MB cache.
While an image changes during recording, the last complete frame remains
visible with a loading spinner; audio and video timestamps keep advancing.

There is no extra native tracking/rendering SDK. The cost is maintaining
this iOS adapter and testing camera/audio lifecycle on a real phone. The
browser/Android implementation remains separate. Vision and MediaPipe
landmarks can give slightly different cutout shapes; iPhone performance,
heat, interruptions, and bluetooth audio need device testing.

From `apps/mobile`, run `pnpm test:native:macos` on a Mac with Command Line
Tools. It exercises real Apple encoding/decoding, audio in short callbacks,
retained image handles, path fill/stroke, all seven drawers, and live hosted
images. It prints the MP4/PNG locations. This is not an iPhone camera test.
Use `pnpm test:native:macos --long` for a two-minute recording proof.
The EAS preview workflow compiles and signs the actual iPhone application.

A throwing project filter stops a pending capture or recording visibly; it
never silently saves unfiltered footage. Retry or selecting a valid filter
restarts preview, including returning to the previously selected filter.

Metro builds `native-runtime.generated.ts` before bundling. Changes to filter
JavaScript can ship through EAS Update; Swift/module changes need a native
build. Restart Metro after editing shared filter logic during local dev.
The portable project-filter API is in `../../docs/project-filters.md`.
