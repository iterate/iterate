import { type RouteConfig, index, prefix, route, layout } from "@react-router/dev/routes";

export default [
  // Public routes (no auth required)
  route("/login", "./routes/login.tsx"),

  layout("./routes/auth-required.layout.tsx", [
    // index - doesn't render anything, it just redirects
    index("./routes/index.tsx"),

    route("/user-settings", "./routes/user-settings.tsx"),
    route("/new-organization", "./routes/new-organization.tsx"),

    // Admin routes (admin only, no estate context required)
    route("/admin", "./routes/admin/layout.tsx", [
      index("./routes/admin/index.tsx"),
      route("session-info", "./routes/admin/session-info.tsx"),
      route("slack-notification", "./routes/admin/slack-notification.tsx"),
      route("db-tools", "./routes/admin/db-tools.tsx"),
      route("trpc-tools", "./routes/admin/trpc-tools.tsx"),
      route("estates", "./routes/admin/estates.tsx"),
    ]),

    layout(
      "./routes/org/layout.tsx",
      prefix(":organizationId", [
        // Index route doesn't have anything, it just redirects to the first estate
        index("./routes/org/index.tsx"),

        // Organization-level routes (no estate context)
        route("settings", "./routes/org/settings.tsx"),
        route("team", "./routes/org/team.tsx"),

        // Estate-specific routes with their own loader
        layout(
          "./routes/org/estate/layout.tsx",
          prefix(":estateId", [
            index("./routes/org/estate/index.tsx"),

            route("onboarding", "./routes/org/estate/onboarding.tsx"),
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
        ),
      ]),
    ),
  ]),

  // Catch-all route for 404
  route("*", "./routes/404.tsx"),
] satisfies RouteConfig;
