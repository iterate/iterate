import "react-native-url-polyfill/auto";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Stack, useGlobalSearchParams, usePathname, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { initialWindowMetrics, SafeAreaProvider } from "react-native-safe-area-context";
import { SessionErrorBoundary } from "../components/error-boundary.tsx";
import { queryClient } from "../lib/query.ts";
import { routeInitialNotification } from "../lib/push-device.ts";
import { installSessionErrorLogger, logScreenView } from "../lib/session-log.ts";
import { installSessionLogMirror } from "../lib/session-log-mirror.ts";
import { colors } from "../lib/theme.ts";

installSessionErrorLogger();
installSessionLogMirror();

export default function RootLayout() {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <QueryClientProvider client={queryClient}>
        <SessionErrorBoundary>
          <ScreenViewLogger />
          <RootStack />
        </SessionErrorBoundary>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

/** Feeds the session log's screen-viewed trail. Render-time call rather than
 * useEffect (house rules): logScreenView dedupes on pathname, so re-renders
 * and a thrown-away concurrent render are no-ops. */
function ScreenViewLogger() {
  const pathname = usePathname();
  const params = useGlobalSearchParams();
  logScreenView(pathname, params);
  return null;
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
