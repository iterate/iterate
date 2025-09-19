import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  // Public routes (no auth required)
  route("/login", "./routes/login.tsx"),
  route("/no-access", "./routes/no-access.tsx"),

  // Root index - will handle redirect logic to org/estate routes
  index("./routes/root-redirect.tsx"),

  // Protected routes with org/estate prefix
  route(":organizationId/:estateId", "./routes/estate-layout.tsx", [
    index("./routes/home.tsx"),
    route("integrations", "./routes/integrations.tsx"),
    route("estate", "./routes/estate.tsx"),
    route("agents", "./routes/agents-index.tsx"),
    route("agents/:agentClassName/:durableObjectName", "./routes/agents.tsx"),
  ]),

  // Catch-all route for 404
  route("*", "./routes/404.tsx"),
] satisfies RouteConfig;
