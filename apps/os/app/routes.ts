import { type RouteConfig, index, prefix, route, layout } from "@react-router/dev/routes";

export default [
  // Public routes (no auth required)
  route("/login", "./routes/login.tsx"),
  route("/get-started", "./routes/get-started.tsx"),
  route("/no-access", "./routes/no-access.tsx"),

  // Trial routes (requires auth but no specific org/estate context)
  route("/trial/slack-connect", "./routes/trial/slack-connect.tsx"),

  // User settings route (requires auth but no specific org/estate context)
  route("/user-settings", "./routes/user-settings.tsx"),

  // Root index - will handle redirect logic to org/estate routes
  index("./routes/redirect.tsx"),

  // New organization creation
  route("/new-organization", "./routes/new-organization.tsx"),

  // Admin routes (admin only, no estate context required)
  route("/admin", "./routes/admin/layout.tsx", [
    index("./routes/admin/index.tsx"),
    route("session-info", "./routes/admin/session-info.tsx"),
    route("slack-notification", "./routes/admin/slack-notification.tsx"),
    route("slack-channel-routing", "./routes/admin/slack-channel-routing.tsx"),
    route("trial-channel-setup", "./routes/admin/trial-channel-setup.tsx"),
    route("db-tools", "./routes/admin/db-tools.tsx"),
    route("trpc-tools", "./routes/admin/trpc-tools.tsx"),
    route("estates", "./routes/admin/estates.tsx"),
  ]),

  // loader.tsx doesn't apply a layout
  route(":organizationId", "./routes/org/loader.tsx", [
    route("onboarding/:step?", "./routes/org/onboarding.tsx"),

    layout("./routes/org/layout.tsx", [
      // Redirect org index to first estate
      index("./routes/org/redirect.tsx"),

      // Organization-level routes (no estate context)
      route("settings", "./routes/org/settings.tsx"),
      route("team", "./routes/org/team.tsx"),

      // Estate-specific routes with their own loader
      route(":estateId", "./routes/org/estate/loader.tsx", [
        index("./routes/org/estate/index.tsx"),
        route("repo", "./routes/org/estate/repo.tsx"),

        ...prefix("integrations", [
          index("./routes/org/estate/integrations/index.tsx"),
          route("mcp-params", "./routes/org/estate/integrations/mcp-params.tsx"),
          route("redirect", "./routes/org/estate/integrations/redirect.tsx"),
        ]),

        ...prefix("agents", [
          route("offline", "./routes/offline-agent-detail.tsx"),
          route(":agentClassName/:durableObjectName", "./routes/online-agent-detail.tsx"),
        ]),
      ]),
    ]),
  ]),

  // Catch-all route for 404
  route("*", "./routes/404.tsx"),
] satisfies RouteConfig;
