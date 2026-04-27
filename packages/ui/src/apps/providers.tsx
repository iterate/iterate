import { useMemo, type ReactNode } from "react";
import { ThemeProvider, type ThemeProviderProps } from "next-themes";
import {
  PostHogProvider,
  setupPosthog,
  shouldEnablePosthog,
  type SetupPosthogOptions,
} from "../components/posthog.tsx";
import { Toaster } from "../components/sonner.tsx";
import { TooltipProvider } from "../components/tooltip.tsx";
import { ConfigProvider } from "./config.tsx";

interface AppProvidersPosthogOptions extends SetupPosthogOptions {
  enabled?: boolean;
}

export function AppProviders<TConfig>(props: {
  config: TConfig;
  children: ReactNode;
  devtools: ReactNode;
  posthog?: AppProvidersPosthogOptions;
  theme?: Pick<ThemeProviderProps, "defaultTheme" | "enableSystem" | "forcedTheme" | "storageKey">;
}) {
  const posthogApiKey = props.posthog?.apiKey ?? getPosthogApiKeyFromConfig(props.config);
  const proxyUrl = props.posthog?.proxyUrl ?? "/posthog-proxy";
  const uiHost = props.posthog?.uiHost;
  const appStage = props.posthog?.appStage;
  const bootstrapFromUrl = props.posthog?.bootstrapFromUrl ?? true;
  const sessionRecording = props.posthog?.sessionRecording;
  const posthogEnabled = props.posthog?.enabled ?? shouldEnablePosthog(posthogApiKey);
  const posthogClient = useMemo(
    () =>
      setupPosthog({
        apiKey: posthogApiKey,
        proxyUrl,
        uiHost,
        appStage,
        bootstrapFromUrl,
        sessionRecording,
      }),
    [appStage, bootstrapFromUrl, posthogApiKey, proxyUrl, sessionRecording, uiHost],
  );

  return (
    <ConfigProvider value={props.config}>
      <ThemeProvider
        attribute="class"
        defaultTheme={props.theme?.defaultTheme ?? "system"}
        enableSystem={props.theme?.enableSystem ?? true}
        forcedTheme={props.theme?.forcedTheme}
        enableColorScheme
        storageKey={props.theme?.storageKey ?? "theme"}
        disableTransitionOnChange
      >
        <PostHogProvider client={posthogClient} enabled={posthogEnabled}>
          {/* Base UI tooltips are intended to share a provider; setting delay=0
              here makes hover tooltips feel immediate across the app.
              First-party docs:
              https://github.com/mui/base-ui/blob/master/docs/src/app/(docs)/react/components/tooltip/page.mdx */}
          <TooltipProvider delay={0}>
            {props.children}
            <Toaster />
            {props.devtools}
          </TooltipProvider>
        </PostHogProvider>
      </ThemeProvider>
    </ConfigProvider>
  );
}

function getPosthogApiKeyFromConfig(config: unknown) {
  if (!isRecord(config)) {
    return undefined;
  }

  const posthog = config.posthog;
  if (!isRecord(posthog)) {
    return undefined;
  }

  return typeof posthog.apiKey === "string" ? posthog.apiKey : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
