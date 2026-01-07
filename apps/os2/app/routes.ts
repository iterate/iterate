import {
  rootRoute,
  route,
  layout,
  index,
} from "@tanstack/virtual-file-routes";

export const routes = rootRoute("root.tsx", [
  // Public routes
  route("/login", "login.tsx"),

  // Auth required layout
  layout("auth-required.layout.tsx", [
    // Index redirects to first org
    index("index.tsx"),

    // New organization
    route("/new-organization", "new-organization.tsx"),

    // User settings
    route("/user/settings", "user/settings.tsx"),

    // Organization routes
    layout("/orgs/$organizationSlug", "org/layout.tsx", [
      // Org index redirects to first project
      index("org/index.tsx"),

      // Org settings
      route("/settings", "org/settings.tsx"),
      route("/team", "org/team.tsx"),
      route("/projects/new", "org/project/new.tsx"),

      // Project routes
      layout("/projects/$projectSlug", "org/project/layout.tsx", [
        // Project index shows access tokens
        index("org/project/index.tsx"),
        route("/machines", "org/project/machines.tsx"),
        route("/repo", "org/project/repo.tsx"),
        route("/connectors", "org/project/connectors.tsx"),
        route("/env-vars", "org/project/env-vars.tsx"),
        route("/settings", "org/project/settings.tsx"),
        route("/agents", "org/project/agents.tsx"),
      ]),
    ]),

    // Admin routes
    layout("/admin", "admin/layout.tsx", [
      index("admin/index.tsx"),
      route("/trpc-tools", "admin/trpc-tools.tsx"),
      route("/session-info", "admin/session-info.tsx"),
    ]),
  ]),
]);
