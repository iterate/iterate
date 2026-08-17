import "react-native-url-polyfill/auto";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Stack, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Alert } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { initialWindowMetrics, SafeAreaProvider } from "react-native-safe-area-context";
import { NoteCaptureOverlay } from "../components/note-composer.tsx";
import { resetChannelOverrideForNewInstall } from "../lib/native-install-guard.ts";
import { fetchLatestUpdateAndReload } from "../lib/preview-channel.ts";
import { queryClient } from "../lib/query.ts";
import { routeInitialNotification } from "../lib/push-device.ts";
import { colors } from "../lib/theme.ts";

export default function RootLayout() {
  return (
    // GestureHandlerRootView: required once at the root for GestureDetector
    // (the media viewer's pinch/pan/tap) to receive events.
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider initialMetrics={initialWindowMetrics}>
        <QueryClientProvider client={queryClient}>
          <RootStack />
          {/* Global capture composer — floats above every screen (chat
              excepted); see components/note-composer.tsx. */}
          <NoteCaptureOverlay />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function RootStack() {
  const segments = useSegments();
  // Runs at the root so it beats any screen that might SET an override this
  // session (the preview-channel confirm screen most of all): a channel
  // override that predates this binary's install is cleared — installing a
  // build means wanting THAT build, not whatever an old override OTA-pulls
  // over it. Force-clear plus a notice, per the "native installs overpower
  // the OTA setting" rule (lib/native-install-guard.ts).
  useQuery({
    queryKey: ["native-install-guard"],
    queryFn: async () => {
      const cleared = await resetChannelOverrideForNewInstall();
      if (cleared !== null) {
        Alert.alert(
          "New build installed",
          `Cleared the preview-channel override "${cleared}" — this install runs its own default channel. Scan a PR's QR to point it at a preview channel again.`,
          [
            { text: "OK" },
            { text: "Pull latest now", onPress: () => void fetchLatestUpdateAndReload() },
          ],
        );
      }
      return cleared;
    },
    retry: false,
    staleTime: Infinity,
  });
  useQuery({
    queryKey: ["initial-notification"],
    queryFn: async () => {
      await routeInitialNotification();
      return true;
    },
    enabled: segments[0] === "project" || segments[0] === "projects",
    retry: false,
    staleTime: Infinity,
  });
  return (
    <>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.text,
          headerShadowVisible: false,
          contentStyle: { backgroundColor: colors.background },
        }}
      />
    </>
  );
}
