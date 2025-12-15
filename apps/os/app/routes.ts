import { index, route, layout, rootRoute } from "@tanstack/virtual-file-routes";

// All routes are read relative to 'apps/routes' directory
export const routes = rootRoute("root.tsx", [
  // Public routes (no auth required)
  route("/login", "login.tsx"),

  layout("auth.layout", "auth-required.layout.tsx", [
    // index - doesn't render anything, it just redirects
    index("index.tsx"),

    route("/user-settings", "user-settings.tsx"),
    route("/new-organization", "new-organization.tsx"),

    // Admin routes (admin only, no installation context required)
    route("/admin", "admin/layout.tsx", [
      index("admin/index.tsx"),
      route("session-info", "admin/session-info.tsx"),
      route("slack-notification", "admin/slack-notification.tsx"),
      route("db-tools", "admin/db-tools.tsx"),
      route("trpc-tools", "admin/trpc-tools.tsx"),
      route("installations", "admin/installations.tsx"),
    ]),

    route("$organizationId", "org/layout.tsx", [
      // Index route doesn't have anything, it just redirects to the first installation
      index("org/index.tsx"),

      // Organization-level routes (no installation context)
      route("settings", "org/settings.tsx"),
      route("team", "org/team.tsx"),

      // Installation-specific routes with their own loader
      route("$installationId", "org/installation/layout.tsx", [
        index("org/installation/index.tsx"),
        route("onboarding", "org/installation/onboarding.tsx"),
        route("repo", "org/installation/repo.tsx"),
        route("integrations", [
          index("org/installation/integrations/index.tsx"),
          route("mcp-params", "org/installation/integrations/mcp-params.tsx"),
          route("redirect", "org/installation/integrations/redirect.tsx"),
        ]),
        route("agents", [
          route("offline", "offline-agent-detail.tsx"),
          route("$agentClassName/$durableObjectName", "online-agent-detail.tsx"),
        ]),
      ]),
    ]),
  ]),
]);
