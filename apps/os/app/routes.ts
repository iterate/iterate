import { rootRoute, route, layout, index } from "@tanstack/virtual-file-routes";

export const routes = rootRoute("root.tsx", [
  // Public routes
  route("/login", "login.tsx"),
  route("/logout", "logout.tsx"),

  // Auth required layout (underscore prefix = pathless)
  layout("_auth", "auth-required.layout.tsx", [
    // Index - shows invites + create org for new users, redirects to org for existing
    index("index.tsx"),

    // Slack conflict resolution
    route("/slack-conflict", "slack-conflict.tsx"),

    // User settings
    route("/user/settings", "user/settings.tsx"),

    // Simplified project routes (project slugs are globally unique)
    route("/proj/$projectSlug", "proj/layout.tsx", [
      index("proj/index.tsx"),
      route("/access-tokens", "proj/access-tokens.tsx"),
      route("/machines", "proj/machines.tsx"),
      route("/machines/$machineId", "proj/machine-detail.tsx"),
      route("/connectors", "proj/connectors.tsx"),
      route("/env-vars", "proj/env-vars.tsx"),
      route("/approvals", "proj/approvals.tsx"),
      route("/settings", "proj/settings.tsx"),
    ]),

    // Organization routes
    route("/orgs/$organizationSlug", "org/layout.tsx", [
      // Org dashboard
      index("org/index.tsx"),

      // Org settings
      route("/settings", "org/settings.tsx"),
      route("/team", "org/team.tsx"),
      route("/billing", "org/billing.tsx"),
      route("/new-project", "org/new-project.tsx"),
    ]),

    // Admin routes
    route("/admin", "admin/layout.tsx", [
      index("admin/index.tsx"),
      route("/trpc-tools", "admin/trpc-tools.tsx"),
      route("/session-info", "admin/session-info.tsx"),
      route("/outbox", "admin/outbox.tsx"),
    ]),
  ]),
]);
