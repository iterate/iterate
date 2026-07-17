import "react-native-url-polyfill/auto";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { queryClient } from "../lib/query.ts";
import { routeInitialLocationReminderNotification } from "../lib/location-reminder-runtime.ts";
import { colors } from "../lib/theme.ts";

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <RootStack />
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}

function RootStack() {
  useQuery({
    queryKey: ["initial-location-reminder-notification"],
    queryFn: async () => {
      await routeInitialLocationReminderNotification();
      return true;
    },
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
