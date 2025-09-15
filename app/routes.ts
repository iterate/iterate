import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("/integrations", "routes/integrations.tsx"),
  route("/estate", "routes/estate.tsx"),
] satisfies RouteConfig;
