import "react-native-url-polyfill/auto";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { router, Stack, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Alert } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { initialWindowMetrics, SafeAreaProvider } from "react-native-safe-area-context";
import { NoteCaptureOverlay } from "../components/note-composer.tsx";
import { UpdateBanner } from "../components/update-banner.tsx";
import {
  fetchLatestUpdateAndReload,
  resetChannelOverrideForNewInstall,
} from "../lib/build-state.ts";
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
          {/* "There's newer JS on this channel" — only ever shown for a
              watched build; see components/update-banner.tsx. */}
          <UpdateBanner />
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
  // over it. And a new binary's first boot opens Build info, so "did the
  // install take?" is answered by the screen that names the channel and
  // commit, not by guessing. Queries run post-mount, so the router is up.
  useQuery({
    queryKey: ["native-install-guard"],
    queryFn: async () => {
      const result = await resetChannelOverrideForNewInstall();
      if (result.binaryChanged) {
        router.push("/build-info");
      }
      if (result.clearedOverride !== null) {
        Alert.alert(
          "New build installed",
          `Cleared the preview-channel override "${result.clearedOverride}" — this install runs its own channel. Scan a PR's QR to point it elsewhere again.`,
          [
            { text: "OK" },
            { text: "Pull latest now", onPress: () => void fetchLatestUpdateAndReload() },
          ],
        );
      }
      return result;
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
