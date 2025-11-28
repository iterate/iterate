import { test, expect, vi } from "vitest";
import { z } from "zod";
import { WebClient } from "@slack/web-api";
import { chromium, type Browser, type Page } from "playwright";
import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";
import { makeVitestTrpcClient } from "./utils/test-helpers/vitest/e2e/vitest-trpc-client.ts";

/**
 * E2E: Connect to mock MCP server (bearer) via Slack → configure via web UI → use a tool
 *
 * Flow:
 * 1) Send Slack message instructing connection to MCP server at http://localhost:8789/bearer/mcp
 * 2) Bot replies with an "Authorize <hostname>" button containing the MCP params URL
 * 3) Open that URL in Playwright, set cookie for impersonated user, fill Authorization header "Bearer test", save
 * 4) Post a Slack message asking the agent to use mock_echo("hello")
 * 5) Verify bot replies containing echoed "hello"
 */

const TestEnv = z.object({
  WORKER_URL: z.string().url(),
  SERVICE_AUTH_TOKEN: z.string().optional(),
  ONBOARDING_E2E_TEST_SETUP_PARAMS: z
    .string()
    .transform((val) => JSON.parse(val))
    .pipe(
      z.object({
        slack: z.object({
          bot: z.object({
            id: z.string(),
            accessToken: z.string(),
          }),
          user: z.object({
            accessToken: z.string(),
          }),
          targetChannelId: z.string(),
        }),
      }),
    ),
});

type CookiePair = { name: string; value: string };

test("connect to mock MCP (bearer) and use echo tool", { timeout: 10 * 60 * 1000 }, async () => {
  const env = TestEnv.parse({
    WORKER_URL: process.env.WORKER_URL,
    SERVICE_AUTH_TOKEN: process.env.SERVICE_AUTH_TOKEN,
    ONBOARDING_E2E_TEST_SETUP_PARAMS: process.env.ONBOARDING_E2E_TEST_SETUP_PARAMS,
  } satisfies Partial<z.input<typeof TestEnv>>);

  const workerUrl = env.WORKER_URL;
  const testSeedData = env.ONBOARDING_E2E_TEST_SETUP_PARAMS;

  const slackUserClient = new WebClient(testSeedData.slack.user.accessToken);
  const slackBotClient = new WebClient(testSeedData.slack.bot.accessToken);

  if (!env.SERVICE_AUTH_TOKEN) {
    throw new Error("SERVICE_AUTH_TOKEN is required for this test");
  }
  const serviceAuthResponse = await fetch(`${workerUrl}/api/auth/service-auth/create-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serviceAuthToken: env.SERVICE_AUTH_TOKEN }),
  });
  if (!serviceAuthResponse.ok) {
    const error = await serviceAuthResponse.text();
    throw new Error(`Failed service auth: ${error}`);
  }
  const serviceAuthCookies = serviceAuthResponse.headers.get("set-cookie");
  if (!serviceAuthCookies) {
    throw new Error("No service auth cookies returned");
  }
  const adminTrpc = makeVitestTrpcClient({
    url: `${workerUrl}/api/trpc`,
    headers: { cookie: serviceAuthCookies },
    log: vi.fn(),
  });

  const setup = await adminTrpc.admin.setupTestOnboardingUser.mutate();
  if (!setup) throw new Error("Failed to setup test onboarding user");
  const createdUserEmail = setup.user.email;

  try {
    const authClient = createAuthClient({
      baseURL: workerUrl,
      plugins: [adminClient()],
    });
    const impersonationCookiePairs: CookiePair[] = [];
    const iterateEstateResp = await adminTrpc.admin["getIterateSlackEstateId"].query();
    const iterateEstateId: string | null = iterateEstateResp?.estateId ?? null;
    if (!iterateEstateId) {
      throw new Error("Iterate Slack estate id not found");
    }
    const slackBotUserId = testSeedData.slack.bot.id;
    const slackUserRecord = await adminTrpc.admin["findUserBySlackAccountId"].query({
      slackUserId: slackBotUserId,
    });
    if (!slackUserRecord?.id) {
      throw new Error("Slack bot user not found for impersonation");
    }
    await (adminTrpc as any).admin["disconnectAllPersonalMcpForUser"].mutate({
      userId: slackUserRecord.id,
    });
    const impersonationResult = await authClient.admin.impersonateUser(
      { userId: slackUserRecord.id },
      {
        headers: { cookie: serviceAuthCookies || "", origin: workerUrl },
        onResponse(context: { response: Response }) {
          impersonationCookiePairs.splice(
            0,
            impersonationCookiePairs.length,
            ...getCookiePairs(context.response.headers),
          );
        },
      },
    );
    if (!impersonationResult?.data || impersonationCookiePairs.length === 0) {
      throw new Error("Failed to impersonate a user for UI access");
    }
    const impersonationCookieHeader = formatCookieHeader(impersonationCookiePairs);

    const connectText = [
      `Hey <@${testSeedData.slack.bot.id}> connect to the MCP server at http://localhost:8789/bearer?expected=test.`,
      "It requires an Authorization header with a Bearer token.",
      "Please prepare the configuration link.",
    ].join(" ");
    const postRes = await slackUserClient.chat.postMessage({
      channel: testSeedData.slack.targetChannelId,
      text: connectText,
    });
    if (!postRes.ok || !postRes.ts) throw new Error("Failed to post Slack message");
    const threadTs = postRes.ts;

    let paramsCollectionUrl: string | null = null;
    await expect
      .poll(
        async () => {
          const replies = await slackBotClient.conversations.replies({
            channel: testSeedData.slack.targetChannelId,
            ts: threadTs,
          });
          const buttons = extractSlackButtons(replies.messages ?? [], testSeedData.slack.bot.id);
          if (!paramsCollectionUrl && buttons[0]?.url) {
            paramsCollectionUrl = buttons[0].url;
          }
          return buttons;
        },
        { timeout: 120_000, interval: 2_000 },
      )
      .toContainEqual(
        expect.objectContaining({
          url: expect.stringMatching(/^https?:\/\/.+/),
        }),
      );
    if (!paramsCollectionUrl) {
      throw new Error("Failed to locate MCP params URL");
    }

    const impersonatedTrpc = makeVitestTrpcClient({
      url: `${workerUrl}/api/trpc`,
      headers: { cookie: impersonationCookieHeader },
      log: vi.fn(),
    });
    const impInfo = await impersonatedTrpc.admin.impersonationInfo.query();
    if (!impInfo) {
      throw new Error("Impersonation check failed");
    }
    const existing = await impersonatedTrpc.integrations.list.query({
      estateId: iterateEstateId,
    } as any);
    const mcpConnections: Array<any> = existing?.mcpConnections ?? [];
    for (const conn of mcpConnections) {
      await impersonatedTrpc.integrations.disconnectMCP.mutate({
        estateId: iterateEstateId,
        connectionId: conn.id,
        connectionType: conn.type, // "mcp-params" | "mcp-oauth"
        mode: (conn.mode as "company" | "personal") ?? "personal",
      } as any);
    }
    const browser: Browser = await chromium.launch({ headless: false });
    try {
      const context = await browser.newContext();
      const appURL = new URL(paramsCollectionUrl);
      for (const { name, value } of impersonationCookiePairs) {
        await context.addCookies([
          {
            name,
            value,
            domain: appURL.hostname,
            path: "/",
            httpOnly: true,
            secure: appURL.protocol === "https:",
            sameSite: "Lax",
          },
        ]);
      }
      const page: Page = await context.newPage();
      await page.goto(paramsCollectionUrl, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Save and Connect" }).waitFor();
      const authInput = page.locator('form [data-slot="input"]').first();
      await authInput.waitFor({ state: "visible" });
      await authInput.scrollIntoViewIfNeeded();
      await authInput.fill("Bearer test");
      await page.getByRole("button", { name: "Save and Connect" }).click();

      await page.waitForURL(/^https?:\/\/[^\.]*\.slack\.com/); // any subdomain of slack.com

      await context.close();
    } finally {
      await browser.close();
    }

    await expect
      .poll(
        async () => {
          const replies = await slackBotClient.conversations.replies({
            channel: testSeedData.slack.targetChannelId,
            ts: threadTs,
            limit: 20,
          });
          return (replies.messages ?? [])
            .filter((msg) => msg.user === testSeedData.slack.bot.id)
            .map((msg) => {
              const segments: string[] = [];
              if (typeof msg.text === "string") {
                segments.push(msg.text);
              }
              const blocks = (msg as any).blocks;
              if (Array.isArray(blocks)) {
                for (const block of blocks) {
                  const blockText = block?.text?.text;
                  if (typeof blockText === "string") {
                    segments.push(blockText);
                  }
                  if (Array.isArray(block?.elements)) {
                    for (const element of block.elements) {
                      const elementText =
                        typeof element?.text?.text === "string"
                          ? element.text.text
                          : typeof element?.text === "string"
                            ? element.text
                            : undefined;
                      if (typeof elementText === "string") {
                        segments.push(elementText);
                      }
                    }
                  }
                }
              }
              return { segments };
            });
        },
        { timeout: 20_000, interval: 2_000 },
      )
      .toContainEqual(
        expect.objectContaining({
          segments: expect.arrayContaining([expect.stringMatching(/connected/i)]),
        }),
      );

    const toolPrompt = [
      `Hey <@${testSeedData.slack.bot.id}> Using the MCP server you just connected to,`,
      "call the MCP tool named 'mock_calculate' with arguments { operation: 'add', a: 123, b: 456 }.",
      "Return only the tool output verbatim and do not compute this yourself.",
    ].join(" ");
    const toolRes = await slackUserClient.chat.postMessage({
      channel: testSeedData.slack.targetChannelId,
      thread_ts: threadTs,
      text: toolPrompt,
    });
    if (!toolRes.ok || !toolRes.ts) throw new Error("Failed to post tool request");

    const agentParamsRaw = new URL(paramsCollectionUrl).searchParams.get("agentDurableObject");
    const agentParams: { durableObjectName: string; className: string } | null = agentParamsRaw
      ? JSON.parse(agentParamsRaw)
      : null;
    if (!agentParams?.durableObjectName || !agentParams?.className) {
      throw new Error("Missing agent durable object info in params URL");
    }
    await expect
      .poll(
        async () => {
          return impersonatedTrpc.agents.getEvents.query({
            estateId: iterateEstateId,
            agentInstanceName: agentParams.durableObjectName,
            agentClassName: agentParams.className as any,
          });
        },
        { timeout: 20_000, interval: 2_000 },
      )
      .toContainEqual(
        expect.objectContaining({
          type: "MCP:CONNECTION_ESTABLISHED",
        }),
      );

    await expect
      .poll(
        async () => {
          const events = await impersonatedTrpc.agents.getEvents.query({
            estateId: iterateEstateId,
            agentInstanceName: agentParams.durableObjectName,
            agentClassName: agentParams.className as any,
          });
          return events.filter((e: any) => e.type === "CORE:LOCAL_FUNCTION_TOOL_CALL");
        },
        { timeout: 20_000, interval: 2_000 },
      )
      .toContainEqual(
        expect.objectContaining({
          type: "CORE:LOCAL_FUNCTION_TOOL_CALL",
          data: expect.objectContaining({
            call: expect.objectContaining({
              name: expect.stringMatching(/^mock_mcp_server_for_e2e_testing_/),
            }),
          }),
        }),
      );
  } finally {
    await adminTrpc.admin.deleteUserByEmail.mutate({ email: createdUserEmail });
  }
});

function extractSlackButtons(messages: any[], botUserId: string): Array<{ url: string }> {
  if (!Array.isArray(messages)) return [];
  const buttons: Array<{ url: string }> = [];
  for (const message of messages) {
    if (message?.user !== botUserId) continue;
    const blocks = (message as any)?.blocks;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block?.type !== "actions" || !Array.isArray(block?.elements)) continue;
      for (const element of block.elements) {
        if (element?.type === "button" && typeof element.url === "string") {
          buttons.push({ url: element.url });
        }
      }
    }
  }
  return buttons;
}

function getCookiePairs(headers: Headers): CookiePair[] {
  const typedHeaders = headers as Headers & { getSetCookie?: () => string[] };
  const setCookieValues = typedHeaders.getSetCookie?.() ?? [];
  const pairs: CookiePair[] = [];
  for (const value of setCookieValues) {
    const firstPart = value.split(";")[0] ?? "";
    const eqIdx = firstPart.indexOf("=");
    if (eqIdx <= 0) continue;
    const name = firstPart.slice(0, eqIdx);
    const val = firstPart.slice(eqIdx + 1);
    if (name && val) {
      pairs.push({ name, value: val });
    }
  }
  return pairs;
}

function formatCookieHeader(pairs: CookiePair[]): string {
  return pairs.map(({ name, value }) => `${name}=${value}`).join("; ");
}
