import type { RouteConfig } from "@react-router/dev/routes";
import { index, route } from "@react-router/dev/routes";

export default [
  index("./routes/index.tsx"),
  route("blog", "./routes/blog.tsx"),
  route("blog/:slug", "./routes/blog.$slug.tsx"),
  route("contact", "./routes/contact.tsx"),
  route("privacy", "./routes/privacy.tsx"),
  route("terms", "./routes/terms.tsx"),
  route("verify", "./routes/verify.tsx"),
  route("*", "./routes/404.tsx")
] satisfies RouteConfig;
