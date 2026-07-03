import "react-native-url-polyfill/auto";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { colors } from "../lib/theme.ts";

const queryClient = new QueryClient({
  defaultOptions: {
    // itx RPC calls fail hard when a socket dies; one retry after
    // resetItxSession is the recovery path, more just delays the error UI.
    queries: { retry: 1, staleTime: 15_000 },
  },
});

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <StatusBar style="light" />
        <Stack
          screenOptions={{
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.text,
            headerShadowVisible: false,
            contentStyle: { backgroundColor: colors.background },
          }}
        />
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
