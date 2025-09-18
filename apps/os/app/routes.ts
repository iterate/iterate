import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("./routes/home.tsx"),
  route("/login", "./routes/login.tsx"),
  route("/integrations", "./routes/integrations.tsx"),
  route("/estate", "./routes/estate.tsx"),
  route("/agents", "./routes/agents-index.tsx"),
  route("/agents/:agentClassName/:durableObjectName", "./routes/agents.tsx"),
  route("*", "./routes/404.tsx"),
] satisfies RouteConfig;
