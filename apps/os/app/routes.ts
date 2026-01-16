import { rootRoute, route, layout, index } from "@tanstack/virtual-file-routes";

export const routes = rootRoute("root.tsx", [
  // Public routes
  route("/login", "login.tsx"),
  route("/logout", "logout.tsx"),
  route("/dev", "dev.tsx"),

  // Auth required layout (underscore prefix = pathless)
  layout("_auth", "auth-required.layout.tsx", [
    // Index - shows invites + create org for new users, redirects to org for existing
    index("index.tsx"),

    // Slack conflict resolution
    route("/slack-conflict", "slack-conflict.tsx"),

    // User settings
    route("/user/settings", "user/settings.tsx"),

    // Organization routes
    route("/orgs/$organizationSlug", "org/layout.tsx", [
      // Org dashboard
      index("org/index.tsx"),

      // Org settings
      route("/settings", "org/settings.tsx"),
      route("/team", "org/team.tsx"),
      route("/billing", "org/billing.tsx"),
      route("/new-project", "org/new-project.tsx"),

      // Project routes
      route("/projects/$projectSlug", "org/project/layout.tsx", [
        index("org/project/index.tsx"),
        route("/access-tokens", "org/project/access-tokens.tsx"),
        route("/machines", "org/project/machines.tsx"),
        route("/machines/$machineId", "org/project/machine-detail.tsx"),
        route("/repo", "org/project/repo.tsx"),
        route("/connectors", "org/project/connectors.tsx"),
        route("/env-vars", "org/project/env-vars.tsx"),
        route("/settings", "org/project/settings.tsx"),
      ]),
    ]),

    // Admin routes
    route("/admin", "admin/layout.tsx", [
      index("admin/index.tsx"),
      route("/trpc-tools", "admin/trpc-tools.tsx"),
      route("/session-info", "admin/session-info.tsx"),
    ]),
  ]),
]);
