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
    layout("/$organizationSlug", "org/layout.tsx", [
      // Org index redirects to first project
      index("org/index.tsx"),

      // Org settings
      route("/settings", "org/settings.tsx"),
      route("/team", "org/team.tsx"),

      // Project routes
      layout("/$projectSlug", "org/project/layout.tsx", [
        // Project index shows machines
        index("org/project/index.tsx"),
        route("/connectors", "org/project/connectors.tsx"),
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
