import "react-native-url-polyfill/auto";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { StyleSheet, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { BUILD_TIMESTAMP } from "../lib/build-info.ts";
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
      <View pointerEvents="none" style={styles.buildStamp}>
        <Text selectable style={styles.buildStampText}>
          {BUILD_TIMESTAMP}
        </Text>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  buildStamp: {
    position: "absolute",
    right: 0,
    bottom: 24,
    left: 0,
    alignItems: "center",
    opacity: 0.55,
  },
  buildStampText: {
    color: colors.textMuted,
    fontSize: 9,
    fontVariant: ["tabular-nums"],
  },
});
