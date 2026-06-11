/**
 * The loopback-export surface of an itx-hosting worker.
 *
 * itx resolves loopback capabilities through `ctx.exports` (dial.ts), and
 * `ctx.exports` only sees classes exported from the *same* worker script. In
 * the per-DO worker topology (docs/worker-topology.md) several workers host
 * dials — project, agent, itx-context, mcp, and the app worker — so each of
 * their entry modules re-exports this module verbatim. One list, identical
 * `ctx.exports` everywhere, no per-worker drift.
 *
 * Everything here is deliberately thin (fetch + D1 + DO stubs); re-exporting
 * the full set costs little bundle weight, while guaranteeing any capability
 * can be provided on any context regardless of which worker hosts it. The
 * bindings these classes need (see each class's Env type) are the
 * LOOPBACK_UNION bindings in alchemy.run.ts.
 */

export { AgentCapability } from "~/domains/agents/entrypoints/agent-capability.ts";
export { AgentToolsCapability } from "~/domains/agents/entrypoints/agent-tools-capability.ts";
export { GmailCapability } from "~/domains/google/entrypoints/gmail-capability.ts";
export { BindingCapability, EgressPipe, ItxEntrypoint, ProjectEgress } from "~/itx/entrypoint.ts";
export { McpClient } from "~/itx/capabilities/mcp-client.ts";
export { UrlDial } from "~/itx/capabilities/url-dial.ts";
export { StreamsCapability } from "~/itx/capabilities/streams.ts";
export { PlatformContext } from "~/itx/platform-context.ts";
export { RepoCapability, ReposCapability } from "~/domains/repos/entrypoints/repo-capability.ts";
export { SecretsCapability } from "~/domains/secrets/entrypoints/secrets-capability.ts";
export { SlackCapability } from "~/domains/slack/entrypoints/slack-capability.ts";
export { StreamsBackend } from "~/domains/streams/entrypoints/streams-backend.ts";
export { WorkspaceCapability } from "~/domains/workspaces/entrypoints/workspace-capability.ts";
