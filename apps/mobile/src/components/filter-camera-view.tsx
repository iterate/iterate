import BrowserCamera from "./filter-camera.tsx";
import type { FilterCameraProps } from "./filter-camera-types.ts";

/** Browser/Android implementation; iPhone resolves filter-camera-view.ios.tsx. */
export default function FilterCameraView(props: FilterCameraProps) {
  return (
    <BrowserCamera
      {...props}
      dom={{
        style: { flex: 1 },
        scrollEnabled: false,
        allowsInlineMediaPlayback: true,
        mediaPlaybackRequiresUserAction: false,
        mediaCapturePermissionGrantType: "grant",
      }}
    />
  );
}
