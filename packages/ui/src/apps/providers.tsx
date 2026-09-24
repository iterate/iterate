import type { ReactNode } from "react";
import { initPosthog } from "../components/posthog.tsx";
import { Toaster } from "../components/sonner.tsx";
import { TooltipProvider } from "../components/tooltip.tsx";

/** Every client app's root providers. PostHog starts when the app has a key (envs.ts hands one to
 *  prd only). */
export function AppProviders(props: { children: ReactNode; posthogApiKey?: string }) {
  initPosthog(props.posthogApiKey);

  return (
    // Base UI tooltips are intended to share a provider; setting delay=0
    // here makes hover tooltips feel immediate across the app.
    // First-party docs:
    // https://github.com/mui/base-ui/blob/master/docs/src/app/(docs)/react/components/tooltip/page.mdx
    <TooltipProvider delay={0}>
      {props.children}
      {/* Light mode only (docs/frontend-development.md). The vendored Toaster asks next-themes for the
          theme, and with no ThemeProvider mounted it falls back to "system", which follows the OS
          into dark; a `theme` prop overrides it (it spreads the props last). */}
      <Toaster theme="light" />
    </TooltipProvider>
  );
}
