import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  // Public routes (no auth required)
  route("/login", "./routes/login.tsx"),
  route("/no-access", "./routes/no-access.tsx"),

  // Root index - will handle redirect logic to org/estate routes
  index("./routes/root-redirect.tsx"),

  // Organization-scoped routes (no estate context required)
  route(":organizationId", "./routes/org-layout.tsx", [
    index("./routes/org-redirect.tsx"),
    route("settings", "./routes/org-settings.tsx"),
    route("members", "./routes/org-members.tsx"),
    route("billing", "./routes/org-billing.tsx"),
  ]),

  // Admin routes (admin only, no estate context required)
  route("/admin", "./routes/admin-layout.tsx", [
    index("./routes/admin-redirect.tsx"),
    route("session-info", "./routes/admin-session-info.tsx"),
    route("slack-notification", "./routes/admin-slack-notification.tsx"),
    route("db-tools", "./routes/admin-db-tools.tsx"),
    route("estates", "./routes/admin-estates.tsx"),
  ]),

  // Protected routes with org/estate prefix
  route(":organizationId/:estateId", "./routes/estate-layout.tsx", [
    index("./routes/home.tsx"),
    route("integrations", "./routes/integrations.tsx"),
    route("integrations/mcp-params", "./routes/integrations.mcp-params.tsx"),
    route("integrations/redirect", "./routes/integrations.redirect.tsx"),
    route("repo", "./routes/estate.tsx"),
    route("estate", "./routes/estate.tsx"),
    route("agents", "./routes/agents-index.tsx"),
    route("agents/start-slack", "./routes/agents.start-slack.tsx"),
    route("agents/:agentClassName/:durableObjectName", "./routes/agents.tsx"),
  ]),

  // Catch-all route for 404
  route("*", "./routes/404.tsx"),
] satisfies RouteConfig;
