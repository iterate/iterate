/**
 * Agent CLI E2E Tests
 *
 * Verifies that coding agent CLIs (opencode, claude, pi, codex) can answer
 * a simple question when given real API keys. Parameterized across Docker
 * and Fly providers.
 *
 * Requires OPENAI_API_KEY and ANTHROPIC_API_KEY in the environment (via Doppler).
 *
 * NOTE: codex uses the Responses API which requires WebSocket connections.
 * These currently fail through caddy's TLS MITM egress path, so the codex
 * test is skipped until WebSocket egress is fixed. See also: codex is not
 * tested in sandbox/test/sandbox-without-daemon.test.ts either.
 *
 * --- Further research: sandbox/ tests that could be ported to jonasland ---
 *
 * sandbox/test/sandbox-without-daemon.test.ts:
 *   - "Minimal Container Tests" — container setup, git operations, shell env
 *     sourcing, DUMMY_ENV_VAR from skeleton .env. Verifies the base image is
 *     sane (git works, .bashrc sources ~/.iterate/.env, repo is cloned).
 *   - "Git Repository State" — repo is valid, can read branch/commit.
 *
 * sandbox/test/daemon-in-sandbox.test.ts:
 *   - Pidnap process supervision (env hot-reload, process state transitions)
 *   - Daemon-backend HTTP endpoints and oRPC health
 *   - Container restart with daemon recovery
 *
 * sandbox/test/provider-base-image.test.ts:
 *   - Provider API surface (create/exec/preview) using a neutral base image
 *
 * sandbox/test/ingress-fetcher.test.ts:
 *   - Sandbox.getFetcher() via ingress proxy on port 8080
 *
 * sandbox/providers/docker/host-sync.test.ts:
 *   - Git state matches host, worktree sync
 *
 * sandbox/providers/docker/cloudflare-tunnel.test.ts:
 *   - Docker + Cloudflare tunnel (trycloudflare) preview URL
 */

import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { Deployment } from "@iterate-com/shared/jonasland/deployment/deployment.ts";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";
import { FlyDeployment } from "@iterate-com/shared/jonasland/deployment/fly-deployment.ts";

const DOCKER_IMAGE = process.env.E2E_DOCKER_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const FLY_IMAGE = process.env.E2E_FLY_IMAGE_REF ?? process.env.JONASLAND_SANDBOX_IMAGE ?? "";
const FLY_API_TOKEN = process.env.FLY_API_TOKEN ?? "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? "";
const hasApiKeys = OPENAI_API_KEY.length > 0 && ANTHROPIC_API_KEY.length > 0;
const runFly = FLY_IMAGE.length > 0 && FLY_API_TOKEN.length > 0;

type DeploymentCase = {
  id: string;
  enabled: boolean;
  create: (overrides?: {
    name?: string;
    signal?: AbortSignal;
    env?: Record<string, string>;
  }) => Promise<Deployment>;
  timeoutOffsetMs: number;
};

const cases: DeploymentCase[] = [
  {
    id: "docker",
    enabled: DOCKER_IMAGE.length > 0,
    create: async (overrides = {}) =>
      await DockerDeployment.create({
        dockerImage: DOCKER_IMAGE,
        ...overrides,
      }),
    timeoutOffsetMs: 0,
  },
  {
    id: "fly",
    enabled: runFly,
    create: async (overrides = {}) =>
      await FlyDeployment.create({
        flyImage: FLY_IMAGE,
        flyApiToken: FLY_API_TOKEN,
        ...overrides,
      }),
    timeoutOffsetMs: 300_000,
  },
].filter((entry) => entry.enabled);

const CLI_TIMEOUT_MS = 120_000;

describe.runIf(cases.length > 0 && hasApiKeys)("agent cli", () => {
  describe.each(cases)("$id", ({ create, timeoutOffsetMs }) => {
    test(
      "opencode answers question",
      async () => {
        await using deployment = await create({
          name: `e2e-agent-cli-${randomUUID().slice(0, 8)}`,
          env: { OPENAI_API_KEY, ANTHROPIC_API_KEY },
          signal: AbortSignal.timeout(45_000 + timeoutOffsetMs),
        });
        await deployment.waitUntilAlive({
          signal: AbortSignal.timeout(30_000 + timeoutOffsetMs),
        });

        const result = await deployment.exec([
          "bash",
          "-l",
          "-c",
          "opencode run 'what is 50 minus 8?'",
        ]);
        expect(result.output).toContain("42");
      },
      CLI_TIMEOUT_MS + timeoutOffsetMs,
    );

    test(
      "claude answers question",
      async () => {
        await using deployment = await create({
          name: `e2e-agent-cli-${randomUUID().slice(0, 8)}`,
          env: { OPENAI_API_KEY, ANTHROPIC_API_KEY },
          signal: AbortSignal.timeout(45_000 + timeoutOffsetMs),
        });
        await deployment.waitUntilAlive({
          signal: AbortSignal.timeout(30_000 + timeoutOffsetMs),
        });

        const result = await deployment.exec([
          "bash",
          "-l",
          "-c",
          "claude -p 'what is 50 minus 8?'",
        ]);
        expect(result.output).toContain("42");
      },
      CLI_TIMEOUT_MS + timeoutOffsetMs,
    );

    test(
      "pi answers question",
      async () => {
        await using deployment = await create({
          name: `e2e-agent-cli-${randomUUID().slice(0, 8)}`,
          env: { OPENAI_API_KEY, ANTHROPIC_API_KEY },
          signal: AbortSignal.timeout(45_000 + timeoutOffsetMs),
        });
        await deployment.waitUntilAlive({
          signal: AbortSignal.timeout(30_000 + timeoutOffsetMs),
        });

        const result = await deployment.exec(["bash", "-l", "-c", "pi -p 'what is 50 minus 8?'"]);
        expect(result.output).toContain("42");
      },
      CLI_TIMEOUT_MS + timeoutOffsetMs,
    );

    test.skip(
      "codex answers question",
      async () => {
        await using deployment = await create({
          name: `e2e-agent-cli-${randomUUID().slice(0, 8)}`,
          env: { OPENAI_API_KEY, ANTHROPIC_API_KEY },
          signal: AbortSignal.timeout(45_000 + timeoutOffsetMs),
        });
        await deployment.waitUntilAlive({
          signal: AbortSignal.timeout(30_000 + timeoutOffsetMs),
        });

        const result = await deployment.exec([
          "bash",
          "-l",
          "-c",
          "codex exec 'what is 50 minus 8?'",
        ]);
        expect(result.output).toContain("42");
      },
      CLI_TIMEOUT_MS + timeoutOffsetMs,
    );
  });
});
