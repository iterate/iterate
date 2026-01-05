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

    // // Admin routes (admin only, no estate context required)
    route("/admin", "admin/layout.tsx", [
      index("admin/index.tsx"),
      route("session-info", "admin/session-info.tsx"),
      route("slack-notification", "admin/slack-notification.tsx"),
      route("db-tools", "admin/db-tools.tsx"),
      route("trpc-tools", "admin/trpc-tools.tsx"),
      route("estates", "admin/estates.tsx"),
    ]),

    route("$organizationId", "org/layout.tsx", [
      // Index route doesn't have anything, it just redirects to the first estate
      index("org/index.tsx"),

      // Organization-level routes (no estate context)
      route("settings", "org/settings.tsx"),
      route("team", "org/team.tsx"),

      // Estate-specific routes with their own loader
      route("$estateId", "org/estate/layout.tsx", [
        index("org/estate/index.tsx"),
        route("repo", "org/estate/repo.tsx"),
        route("integrations", [
          index("org/estate/integrations/index.tsx"),
          route("mcp-params", "org/estate/integrations/mcp-params.tsx"),
          route("redirect", "org/estate/integrations/redirect.tsx"),
        ]),
        route("agents", [
          route("offline", "offline-agent-detail.tsx"),
          route("$agentClassName/$durableObjectName", "online-agent-detail.tsx"),
        ]),
      ]),
    ]),
  ]),
]);
