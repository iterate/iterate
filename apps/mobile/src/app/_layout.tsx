import "react-native-url-polyfill/auto";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Stack, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { initialWindowMetrics, SafeAreaProvider } from "react-native-safe-area-context";
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
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function RootStack() {
  const segments = useSegments();
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
