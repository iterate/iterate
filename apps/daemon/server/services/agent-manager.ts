/**
 * Agent Manager Service
 *
 * Provides testable abstractions for agent lifecycle management.
 * Supports dependency injection for unit testing.
 */
import { randomUUID } from "node:crypto";
import { eq, isNull, and } from "drizzle-orm";
import { db as defaultDb } from "../db/index.ts";
import * as schema from "../db/schema.ts";
import type { Agent, AgentType } from "../db/schema.ts";
import { getHarness as defaultGetHarness, type AgentHarness } from "../agents/index.ts";
import type { AppendParams, AppendResult } from "../agents/types.ts";

export interface GetOrCreateAgentParams {
  slug: string;
  harnessType: AgentType;
  workingDirectory: string;
  initialPrompt?: string;
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
  getHarness: defaultGetHarness,
};

/**
 * Get an agent by slug (lookup only, no creation).
 * Returns null if no agent exists with the given slug.
 */
export async function getAgent(
  slug: string,
  deps: HarnessAgentManagerDeps = defaultHarnessDeps,
): Promise<Agent | null> {
  const { db } = deps;

  const existingAgents = await db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.slug, slug), isNull(schema.agents.archivedAt)))
    .limit(1);

  return existingAgents[0] ?? null;
}

/**
 * Create a new agent using the harness system.
 * Throws if an agent with the slug already exists.
 */
export async function createAgent(
  params: GetOrCreateAgentParams,
  deps: HarnessAgentManagerDeps = defaultHarnessDeps,
): Promise<Agent> {
  const { slug, harnessType, workingDirectory, initialPrompt } = params;
  const { db, getHarness } = deps;

  // Create new agent using harness
  const harness = getHarness(harnessType);
  const id = randomUUID();

  const result = await harness.createAgent({
    slug,
    workingDirectory,
    sessionName: `agent-${id.slice(0, 8)}`,
  });

  // Insert agent into database
  const [newAgent] = await db
    .insert(schema.agents)
    .values({
      id,
      slug,
      harnessType,
      harnessSessionId: result.harnessSessionId,
      workingDirectory,
      initialPrompt,
      status: "running",
    })
    .returning();

  return newAgent;
}

/**
 * Get or create an agent using the new harness system.
 * Uses SDK-based session management (for OpenCode) while preserving terminal UI.
 */
export async function getOrCreateAgent(
  params: GetOrCreateAgentParams,
  deps: HarnessAgentManagerDeps = defaultHarnessDeps,
): Promise<GetOrCreateAgentResult> {
  const { slug } = params;

  const existingAgent = await getAgent(slug, deps);

  if (existingAgent) {
    return {
      agent: existingAgent,
      wasCreated: false,
    };
  }

  const newAgent = await createAgent(params, deps);

  return {
    agent: newAgent,
    wasCreated: true,
  };
}

/**
 * Reset an agent by archiving the old one and creating a fresh session.
 * Returns the newly created agent.
 */
export async function resetAgent(
  params: GetOrCreateAgentParams,
  deps: HarnessAgentManagerDeps = defaultHarnessDeps,
): Promise<Agent> {
  const { slug } = params;
  const { db } = deps;

  // Archive existing agent if present
  const existingAgent = await getAgent(slug, deps);
  if (existingAgent) {
    await db
      .update(schema.agents)
      .set({ archivedAt: new Date(), status: "stopped" })
      .where(eq(schema.agents.slug, slug));
  }

  // Create fresh agent
  return createAgent(params, deps);
}

/**
 * Send a message to an agent using the harness's append method (SDK-based).
 */
export async function appendToAgent(
  agent: Agent,
  message: string,
  params: AppendParams,
  deps: HarnessAgentManagerDeps = defaultHarnessDeps,
): Promise<AppendResult | void> {
  const { getHarness } = deps;

  if (!agent.harnessSessionId) {
    throw new Error(`Agent ${agent.slug} has no harness session ID`);
  }

  const harness = getHarness(agent.harnessType);
  return harness.append(agent.harnessSessionId, { type: "user-message", content: message }, params);
}
