import {
  rootRoute,
  route,
  layout,
  index,
  physical,
} from "@tanstack/virtual-file-routes";

export const routes = rootRoute("root.tsx", [
  route("/login", "login.tsx"),

  layout("_auth-required", "auth-required.layout.tsx", [
    index("index.tsx"),
    route("/new-organization", "new-organization.tsx"),
    route("/user/settings", "user/settings.tsx"),

    layout("/orgs/$organizationSlug", "org/layout.tsx", [
      index("org/index.tsx"),
      route("/settings", "org/settings.tsx"),
      route("/team", "org/team.tsx"),
      route("/projects/new", "org/project/new.tsx"),

      layout("/projects/$projectSlug", "org/project/layout.tsx", [
        index("org/project/index.tsx"),
        route("/machines", "org/project/machines.tsx"),
        route("/repo", "org/project/repo.tsx"),
        route("/connectors", "org/project/connectors.tsx"),
        route("/env-vars", "org/project/env-vars.tsx"),
        route("/settings", "org/project/settings.tsx"),
        route("/agents", "org/project/agents.tsx"),
      ]),
    ]),

    layout("/admin", "admin/layout.tsx", [
      index("admin/index.tsx"),
      route("/api-tools", "admin/api-tools.tsx"),
      route("/session-info", "admin/session-info.tsx"),
    ]),
  ]),
]);
