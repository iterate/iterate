// Which camera (front/back) the user last chose — shared by the full-screen
// capture UI (where flipping writes it) and the attachment sheet's live
// camera tile (which should preview the same lens). Survives restarts via
// AsyncStorage; served through the query cache like the rest of the app.

import AsyncStorage from "@react-native-async-storage/async-storage";
import { useQuery, useQueryClient } from "@tanstack/react-query";

const CAMERA_FACING_KEY = "iterate.cameraFacing.v1";

export function useCameraFacing() {
  const queryClient = useQueryClient();
  const stored = useQuery({
    queryKey: ["camera-facing"],
    queryFn: async () =>
      ((await AsyncStorage.getItem(CAMERA_FACING_KEY)) === "front" ? "front" : "back") as
        | "back"
        | "front",
  });
  const facing = stored.data || "back";
  return {
    facing,
    setFacing: (next: "back" | "front") => {
      queryClient.setQueryData(["camera-facing"], next);
      void AsyncStorage.setItem(CAMERA_FACING_KEY, next);
    },
  };
}
