import { integrationTest as test, describe, expect } from "../fixtures.ts";
import { refreshEnv } from "../helpers/refresh-env.ts";
import {
  mockAnthropicClaudeCodeSettings,
  mockAnthropicCountTokens,
  mockAnthropicMessages,
  mockOpenAIChat,
} from "../mock-iterate-os-api/llm-mocks.ts";

function buildEnvVars(vars: Record<string, string>) {
  return Object.entries(vars).map(([key, value]) => ({
    key,
    value,
    secret: null,
    description: null,
    source: { type: "user" as const, envVarId: `mock-${key.toLowerCase()}` },
  }));
}

const hasProvider =
  process.env.RUN_LOCAL_DOCKER_TESTS === "true" || process.env.RUN_DAYTONA_TESTS === "true";
const describeIfProvider = describe.runIf(hasProvider);

describeIfProvider("Agent CLI", () => {
  test("opencode computes 50-8=42", async ({ sandbox, mock, mockUrl }) => {
    mock.orpc.setGetEnvResponse({
      envVars: buildEnvVars({
        ITERATE_EGRESS_PROXY_URL: `${mockUrl}/api/egress-proxy`,
        ITERATE_OS_API_KEY: "test-key",
        OPENAI_BASE_URL: "https://api.openai.com/v1",
        OPENAI_API_BASE: "https://api.openai.com/v1",
        ANTHROPIC_BASE_URL: "https://api.anthropic.com/v1",
        ANTHROPIC_API_URL: "https://api.anthropic.com/v1",
        OPENAI_API_KEY: "getIterateSecret({secretKey: 'openai_api_key'})",
        ANTHROPIC_API_KEY: "getIterateSecret({secretKey: 'anthropic_api_key'})",
      }),
      repos: [],
    });
    mock.egress.setSecrets({ openai_api_key: "sk-fake", anthropic_api_key: "sk-ant-fake" });
    mock.egress.onRequest(/api\.openai\.com.*chat\/completions/, mockOpenAIChat("42"));
    mock.egress.onRequest(/api\.anthropic\.com.*messages/, mockAnthropicMessages("42"));
    mock.egress.onRequest(/api\.anthropic\.com.*chat\/completions/, mockOpenAIChat("42"));

    await refreshEnv(sandbox);
    await sandbox.waitForServiceHealthy("egress-proxy", 30_000);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const output = await sandbox.exec([
      "bash",
      "-c",
      'source ~/.iterate/.env && HTTPS_PROXY=http://127.0.0.1:8888 HTTP_PROXY=http://127.0.0.1:8888 timeout 45 opencode run "what is 50 - 8?"',
    ]);

    expect(output).toContain("42");

    const reqs = mock.egress.getRequests(/openai|anthropic/);
    expect(reqs.length).toBeGreaterThan(0);
  }, 60_000);

  test("claude answers messaging platform question", async ({ sandbox, mock, mockUrl }) => {
    mock.orpc.setGetEnvResponse({
      envVars: buildEnvVars({
        ITERATE_EGRESS_PROXY_URL: `${mockUrl}/api/egress-proxy`,
        ITERATE_OS_API_KEY: "test-key",
        ANTHROPIC_BASE_URL: "https://api.anthropic.com/v1",
        ANTHROPIC_API_URL: "https://api.anthropic.com/v1",
        ANTHROPIC_API_KEY: "getIterateSecret({secretKey: 'anthropic_api_key'})",
        ANTHROPIC_AUTH_TOKEN: "getIterateSecret({secretKey: 'anthropic_api_key'})",
        CLAUDE_API_KEY: "getIterateSecret({secretKey: 'anthropic_api_key'})",
      }),
      repos: [],
    });
    mock.egress.setSecrets({ anthropic_api_key: "sk-ant-fake" });
    mock.egress.onRequest(
      /api\.anthropic\.com\/api\/claude_code\/settings/,
      mockAnthropicClaudeCodeSettings(),
    );
    mock.egress.onRequest(
      /api\.anthropic\.com.*messages\/count_tokens/,
      mockAnthropicCountTokens(),
    );
    mock.egress.onRequest(/api\.anthropic\.com.*messages/, mockAnthropicMessages("slack"));

    await refreshEnv(sandbox);
    await sandbox.waitForServiceHealthy("egress-proxy", 30_000);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const output = await sandbox.exec([
      "bash",
      "-c",
      "source ~/.iterate/.env && HTTPS_PROXY=http://127.0.0.1:8888 HTTP_PROXY=http://127.0.0.1:8888 claude -p 'what messaging platform?'",
    ]);

    expect(output.toLowerCase()).toContain("slack");
  }, 60_000);

  test("pi answers messaging platform question", async ({ sandbox, mock, mockUrl }) => {
    mock.orpc.setGetEnvResponse({
      envVars: buildEnvVars({
        ITERATE_EGRESS_PROXY_URL: `${mockUrl}/api/egress-proxy`,
        ITERATE_OS_API_KEY: "test-key",
        ANTHROPIC_BASE_URL: "https://api.anthropic.com/v1",
        ANTHROPIC_API_URL: "https://api.anthropic.com/v1",
        ANTHROPIC_API_KEY: "getIterateSecret({secretKey: 'anthropic_api_key'})",
        ANTHROPIC_AUTH_TOKEN: "getIterateSecret({secretKey: 'anthropic_api_key'})",
        CLAUDE_API_KEY: "getIterateSecret({secretKey: 'anthropic_api_key'})",
      }),
      repos: [],
    });
    mock.egress.setSecrets({ anthropic_api_key: "sk-ant-fake" });
    mock.egress.onRequest(
      /api\.anthropic\.com\/api\/claude_code\/settings/,
      mockAnthropicClaudeCodeSettings(),
    );
    mock.egress.onRequest(
      /api\.anthropic\.com.*messages\/count_tokens/,
      mockAnthropicCountTokens(),
    );
    mock.egress.onRequest(/api\.anthropic\.com.*messages/, mockAnthropicMessages("slack"));

    await refreshEnv(sandbox);
    await sandbox.waitForServiceHealthy("egress-proxy", 30_000);
    await new Promise((resolve) => setTimeout(resolve, 2000));

    const output = await sandbox.exec([
      "bash",
      "-c",
      "source ~/.iterate/.env && HTTPS_PROXY=http://127.0.0.1:8888 HTTP_PROXY=http://127.0.0.1:8888 pi -p 'what messaging platform?'",
    ]);

    expect(output.toLowerCase()).toContain("slack");
  }, 60_000);
});
