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

    // Organization routes
    layout("/$organizationSlug", "org/layout.tsx", [
      // Org index redirects to first instance
      index("org/index.tsx"),

      // Org settings
      route("/settings", "org/settings.tsx"),
      route("/team", "org/team.tsx"),
      route("/connectors", "org/connectors.tsx"),

      // Instance routes
      layout("/$instanceSlug", "org/instance/layout.tsx", [
        // Instance index shows machines
        index("org/instance/index.tsx"),
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
