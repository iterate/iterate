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
import {
  createTmuxSession as defaultCreateTmuxSession,
  hasTmuxSession as defaultHasTmuxSession,
  sendKeys as defaultSendKeys,
  isSessionProcessRunning as defaultIsSessionProcessRunning,
} from "../tmux-control.ts";
import {
  getHarness as defaultGetHarness,
  getCommandString,
  type AgentHarness,
} from "../agents/index.ts";

// Per-harness wait times (in ms) for tmux session to be ready
const HARNESS_READY_WAIT_MS: Record<AgentType, number> = {
  pi: 3000,
  "claude-code": 5000,
  opencode: 4000,
};

export interface EnsureAgentRunningParams {
  slug: string;
  harnessType: AgentType;
  workingDirectory: string;
  initialPrompt?: string;
}

export interface EnsureAgentRunningResult {
  agent: Agent;
  wasCreated: boolean;
  tmuxSession: string;
}

export interface AgentManagerDeps {
  db: typeof defaultDb;
  hasTmuxSession: typeof defaultHasTmuxSession;
  createTmuxSession: typeof defaultCreateTmuxSession;
  sendKeys: typeof defaultSendKeys;
  isSessionProcessRunning: typeof defaultIsSessionProcessRunning;
  getHarness: typeof defaultGetHarness;
}

const defaultDeps: AgentManagerDeps = {
  db: defaultDb,
  hasTmuxSession: defaultHasTmuxSession,
  createTmuxSession: defaultCreateTmuxSession,
  sendKeys: defaultSendKeys,
  isSessionProcessRunning: defaultIsSessionProcessRunning,
  getHarness: defaultGetHarness,
};

/**
 * Ensure an agent exists and is running.
 * Creates the agent if it doesn't exist, or reuses existing one.
 * Also ensures the tmux session is started.
 */
export async function ensureAgentRunning(
  params: EnsureAgentRunningParams,
  deps: AgentManagerDeps = defaultDeps,
): Promise<EnsureAgentRunningResult> {
  const { slug, harnessType, workingDirectory, initialPrompt } = params;
  const { db, hasTmuxSession, createTmuxSession, getHarness } = deps;

  // 1. Check if agent already exists (not archived)
  const existingAgents = await db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.slug, slug), isNull(schema.agents.archivedAt)))
    .limit(1);

  const existingAgent = existingAgents[0];

  if (existingAgent) {
    // Agent exists - ensure tmux session is running
    const tmuxSession = existingAgent.tmuxSession!;

    if (!hasTmuxSession(tmuxSession)) {
      // Recreate tmux session
      const harness = getHarness(existingAgent.harnessType);
      const command = harness.getStartCommand(existingAgent.workingDirectory, {
        prompt: existingAgent.initialPrompt ?? undefined,
      });
      const wrapperCommand = buildTmuxCommand(command, existingAgent.workingDirectory);
      createTmuxSession(tmuxSession, wrapperCommand);

      await db.update(schema.agents).set({ status: "running" }).where(eq(schema.agents.slug, slug));
    }

    return {
      agent: existingAgent,
      wasCreated: false,
      tmuxSession,
    };
  }

  // 2. Create new agent
  const id = randomUUID();
  const tmuxSession = `agent-${id.slice(0, 8)}`;

  const [newAgent] = await db
    .insert(schema.agents)
    .values({
      id,
      slug,
      harnessType,
      tmuxSession,
      workingDirectory,
      status: "stopped",
      initialPrompt,
    })
    .returning();

  // 3. Start tmux session
  const harness = getHarness(harnessType);
  const command = harness.getStartCommand(workingDirectory, {
    prompt: initialPrompt,
  });
  const wrapperCommand = buildTmuxCommand(command, workingDirectory);
  const success = createTmuxSession(tmuxSession, wrapperCommand);

  if (success) {
    await db.update(schema.agents).set({ status: "running" }).where(eq(schema.agents.slug, slug));
  }

  return {
    agent: newAgent,
    wasCreated: true,
    tmuxSession,
  };
}

/**
 * Send a message to an agent's tmux session.
 * Waits for the session to be ready (process running) before sending.
 */
export async function sendMessageToAgent(
  tmuxSession: string,
  message: string,
  harnessType: AgentType = "pi",
  deps: AgentManagerDeps = defaultDeps,
): Promise<boolean> {
  const { sendKeys, isSessionProcessRunning } = deps;

  // Wait for session to be ready (process running)
  const maxWaitMs = HARNESS_READY_WAIT_MS[harnessType] || 3000;
  const pollIntervalMs = 100;
  let waited = 0;

  while (waited < maxWaitMs) {
    if (isSessionProcessRunning(tmuxSession)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    waited += pollIntervalMs;
  }

  // Send message as literal keys to avoid tmux interpreting key names
  return sendKeys(tmuxSession, message, true, true); // true = press Enter
}

function buildTmuxCommand(agentCommand: string[], workingDirectory: string): string {
  return `cd "${workingDirectory}" && ${getCommandString(agentCommand)}`;
}

// ============================================================================
// New Harness-Based API (uses SDK for OpenCode, preserves terminal UI)
// ============================================================================

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
  const { slug, harnessType, workingDirectory } = params;
  const { db, getHarness } = deps;

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
