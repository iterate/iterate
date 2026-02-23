import { registerTrackedMutation } from "./middleware/posthog.ts";

/**
 * Register all mutations that should be tracked to PostHog.
 *
 * This file centralizes the configuration of which mutations to track
 * and how to extract safe properties from their inputs.
 */

// Project mutations
registerTrackedMutation("project.create", {
  eventName: "project_created",
  extractProperties: (input: unknown) => {
    const typed = input as { name?: string };
    return { project_name: typed.name };
  },
});

registerTrackedMutation("project.update", {
  eventName: "project_updated",
  extractProperties: (input: unknown) => {
    const typed = input as { name?: string };
    return { has_name_change: !!typed.name };
  },
});

registerTrackedMutation("project.delete", {
  eventName: "project_deleted",
});

// Organization mutations
registerTrackedMutation("organization.create", {
  eventName: "organization_created",
  extractProperties: (input: unknown) => {
    const typed = input as { name?: string };
    return { organization_name: typed.name };
  },
});

// Machine mutations
registerTrackedMutation("machine.create", {
  eventName: "machine_created",
  extractProperties: (input: unknown) => {
    const typed = input as { name?: string };
    return {
      machine_name: typed.name,
    };
  },
});

registerTrackedMutation("machine.archive", {
  eventName: "machine_archived",
});

// Integration connections
registerTrackedMutation("project.startGithubInstallFlow", {
  eventName: "github_integration_started",
});

registerTrackedMutation("project.disconnectGithub", {
  eventName: "github_integration_disconnected",
});

registerTrackedMutation("project.startSlackOAuthFlow", {
  eventName: "slack_integration_started",
});

registerTrackedMutation("project.disconnectSlack", {
  eventName: "slack_integration_disconnected",
});

// Access tokens
registerTrackedMutation("accessToken.create", {
  eventName: "access_token_created",
  extractProperties: (input: unknown) => {
    const typed = input as { name?: string };
    return { token_name: typed.name };
  },
});

registerTrackedMutation("accessToken.revoke", {
  eventName: "access_token_revoked",
});

// Environment variables
registerTrackedMutation("envVar.set", {
  eventName: "env_var_set",
  // Don't include any input - env vars are sensitive
  extractProperties: () => ({}),
});

registerTrackedMutation("envVar.delete", {
  eventName: "env_var_deleted",
  // Only track that it happened, not which key
  extractProperties: () => ({}),
});
