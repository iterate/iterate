import { index, route, layout, rootRoute } from "@tanstack/virtual-file-routes";

export const routes = rootRoute("root.tsx", [
  route("/login", "login.tsx"),

  layout("auth.layout", "auth-required.layout.tsx", [
    index("index.tsx"),

    route("/new-organization", "new-organization.tsx"),

    route("/admin", "admin/layout.tsx", [
      index("admin/index.tsx"),
      route("session-info", "admin/session-info.tsx"),
      route("trpc-tools", "admin/trpc-tools.tsx"),
    ]),

    route("$organizationSlug", "org/layout.tsx", [
      index("org/index.tsx"),

      route("settings", "org/settings.tsx"),
      route("team", "org/team.tsx"),
      route("connectors", "org/connectors.tsx"),

      route("$projectSlug", "org/project/layout.tsx", [index("org/project/index.tsx")]),
    ]),
  ]),
]);
