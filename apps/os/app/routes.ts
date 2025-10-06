import { type RouteConfig, index, prefix, route } from "@react-router/dev/routes";

export default [
  // Public routes (no auth required)
  route("/login", "./routes/login.tsx"),
  route("/no-access", "./routes/no-access.tsx"),

  // User settings route (requires auth but no specific org/estate context)
  route("/user-settings", "./routes/user-settings.tsx"),

  // Root index - will handle redirect logic to org/estate routes
  index("./routes/root-redirect.tsx"),

  // New organization creation
  route("/new-organization", "./routes/new-organization.tsx"),

  // Admin routes (admin only, no estate context required)
  route("/admin", "./routes/admin-layout.tsx", [
    index("./routes/admin-redirect.tsx"),
    route("session-info", "./routes/admin-session-info.tsx"),
    route("slack-notification", "./routes/admin-slack-notification.tsx"),
    route("db-tools", "./routes/admin-db-tools.tsx"),
    route("trpc-tools", "./routes/admin-trpc-tools.tsx"),
    route("estates", "./routes/admin-estates.tsx"),
  ]),

  // All organization routes (with or without estate context)
  route(":organizationId", "./routes/org-layout.tsx", [
    // Organization-level routes
    index("./routes/org-redirect.tsx"),
    route("settings", "./routes/org-settings.tsx"),
    route("team", "./routes/org-team.tsx"),

    // Estate-specific routes
    ...prefix(":estateId", [
      // Estate-specific routes
      index("./routes/home.tsx"),
      route("integrations", "./routes/integrations.tsx"),
      route("integrations/mcp-params", "./routes/integrations.mcp-params.tsx"),
      route("integrations/redirect", "./routes/integrations.redirect.tsx"),
      route("estate", "./routes/estate.tsx"),
      route("agents", "./routes/agents-index.tsx"),
      route("agents/start-slack", "./routes/agents.start-slack.tsx"),
      route("agents/:agentClassName/:durableObjectName", "./routes/agents.tsx"),
    ]),
  ]),

  // Catch-all route for 404
  route("*", "./routes/404.tsx"),
] satisfies RouteConfig;
