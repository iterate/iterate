/**
 * Agent Manager Service
 *
 * Provides testable abstractions for agent lifecycle management.
 * Uses OpenCode SDK for session management - no tmux sessions.
 * Supports dependency injection for unit testing.
 */
import { randomUUID } from "node:crypto";
import { eq, isNull, and } from "drizzle-orm";
import { db as defaultDb } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import type { Agent, AgentType } from "../db/schema.ts";
import { getHarness as defaultGetNewHarness, type AgentHarness } from "../agents/index.ts";

export interface GetOrCreateAgentParams {
  slug: string;
  harnessType: AgentType;
  workingDirectory: string;
}

export interface GetOrCreateAgentResult {
  agent: Agent;
  wasCreated: boolean;
}

export interface HarnessAgentManagerDeps {
  db: typeof defaultDb;
  getHarness: (agentType: AgentType) => AgentHarness;
}

const defaultHarnessDeps: HarnessAgentManagerDeps = {
  db: defaultDb,
  getHarness: defaultGetNewHarness,
};

/**
 * Get or create an agent using the harness system.
 * Uses SDK-based session management (for OpenCode) - no tmux sessions.
 */
export async function getOrCreateAgent(
  params: GetOrCreateAgentParams,
  deps: HarnessAgentManagerDeps = defaultHarnessDeps,
): Promise<GetOrCreateAgentResult> {
  const { slug, harnessType, workingDirectory } = params;
  const { db, getHarness } = deps;

  // Check if agent already exists (not archived)
  const existingAgents = await db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.slug, slug), isNull(schema.agents.archivedAt)))
    .limit(1);

  const existingAgent = existingAgents[0];

  if (existingAgent) {
    return {
      agent: existingAgent,
      wasCreated: false,
    };
  }

  // Create new agent using harness
  const harness = getHarness(harnessType);
  const id = randomUUID();

  const result = await harness.createAgent({
    slug,
    workingDirectory,
    sessionName: `agent-${id.slice(0, 8)}`,
  });

  // Insert agent into database with both session IDs
  const [newAgent] = await db
    .insert(schema.agents)
    .values({
      id,
      slug,
      harnessType,
      harnessSessionId: result.harnessSessionId,
      tmuxSession: result.tmuxSession,
      workingDirectory,
      status: "running",
    })
    .returning();

  return {
    agent: newAgent,
    wasCreated: true,
  };
}

/**
 * Send a message to an agent using the harness's append method (SDK-based).
 */
export async function appendToAgent(
  agent: Agent,
  message: string,
  deps: HarnessAgentManagerDeps = defaultHarnessDeps,
): Promise<void> {
  const { getHarness } = deps;

  if (!agent.harnessSessionId) {
    throw new Error(`Agent ${agent.slug} has no harness session ID`);
  }

  const harness = getHarness(agent.harnessType);
  await harness.append(agent.harnessSessionId, {
    type: "user-message",
    content: message,
  });
}
