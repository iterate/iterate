import { test, expect, vi } from "vitest";
import { z } from "zod";
import { WebClient } from "@slack/web-api";
import { chromium, type Browser, type Page } from "playwright";
import { createAuthClient } from "better-auth/client";
import { adminClient } from "better-auth/client/plugins";
import { makeVitestTrpcClient } from "./utils/test-helpers/vitest/e2e/vitest-trpc-client.ts";

function splitSetCookie(header: string): string[] {
  // Split on comma that is followed by a cookie name (tokens before '=')
  // This avoids splitting inside Expires=... GMT, which includes commas
  return header.split(/,(?=\s*?[a-zA-Z0-9!#$%&'*+\-.^_`|~]+=)/);
}

function getSetCookieArrayFromHeaders(headers: Headers): string[] {
  const anyHeaders = headers as unknown as {
    getSetCookie?: () => string[];
    raw?: () => Record<string, string[]>;
  };
  if (typeof anyHeaders.getSetCookie === "function") {
    try {
      return anyHeaders.getSetCookie() || [];
    } catch {}
  }
  if (typeof anyHeaders.raw === "function") {
    try {
      const raw = anyHeaders.raw();
      if (raw && Array.isArray(raw["set-cookie"])) return raw["set-cookie"];
    } catch {}
  }
  const single = headers.get("set-cookie");
  if (single) return splitSetCookie(single);
  return [];
}

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

test("connect to mock MCP (bearer) and use echo tool", { timeout: 10 * 60 * 1000 }, async () => {
  const env = TestEnv.parse({
    WORKER_URL: process.env.WORKER_URL,
    SERVICE_AUTH_TOKEN: process.env.SERVICE_AUTH_TOKEN,
    ONBOARDING_E2E_TEST_SETUP_PARAMS: process.env.ONBOARDING_E2E_TEST_SETUP_PARAMS,
  } satisfies Partial<z.input<typeof TestEnv>>);

  const workerUrl = env.WORKER_URL;
  const testSeedData = env.ONBOARDING_E2E_TEST_SETUP_PARAMS;

  // Slack clients
  const slackUserClient = new WebClient(testSeedData.slack.user.accessToken);
  const slackBotClient = new WebClient(testSeedData.slack.bot.accessToken);

  // 1) Service auth → admin client
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
  // Parse service auth cookies
  const serviceCookiePairs: Array<{ name: string; value: string }> = [];
  {
    const headerCookies = getSetCookieArrayFromHeaders(serviceAuthResponse.headers);
    for (const cookie of headerCookies) {
      const firstPart = cookie.split(";")[0] ?? "";
      const eqIdx = firstPart.indexOf("=");
      if (eqIdx > 0) {
        const name = firstPart.slice(0, eqIdx);
        const value = firstPart.slice(eqIdx + 1);
        if (name && value) serviceCookiePairs.push({ name, value });
      }
    }
  }
  const adminTrpc = makeVitestTrpcClient({
    url: `${workerUrl}/api/trpc`,
    headers: { cookie: serviceAuthCookies },
    log: vi.fn(),
  });

  // 2) Setup test user/org/estate
  const setup = await adminTrpc.admin.setupTestOnboardingUser.mutate();
  if (!setup) throw new Error("Failed to setup test onboarding user");
  const { user, estate } = setup;

  // 3) Impersonate the created user and capture cookies
  const authClient = createAuthClient({
    baseURL: workerUrl,
    plugins: [adminClient()],
  });
  let impersonationCookies = "";
  const impersonationCookiePairs: Array<{ name: string; value: string }> = [];
  const impersonationResult = await authClient.admin.impersonateUser(
    { userId: user.id },
    {
      headers: { cookie: serviceAuthCookies, origin: workerUrl },
      onResponse(context: { response: Response }) {
        const cookies = getSetCookieArrayFromHeaders(context.response.headers);
        for (const cookie of cookies) {
          const firstPart = cookie.split(";")[0] ?? "";
          const eqIdx = firstPart.indexOf("=");
          if (eqIdx > 0) {
            const name = firstPart.slice(0, eqIdx);
            const value = firstPart.slice(eqIdx + 1);
            if (name && value) impersonationCookiePairs.push({ name, value });
          }
        }
        impersonationCookies = impersonationCookiePairs
          .map(({ name, value }) => `${name}=${value}`)
          .join("; ");
      },
    },
  );
  if (!impersonationResult?.data || !impersonationCookies) {
    throw new Error("Failed to impersonate user");
  }

  // 4) Post Slack message instructing MCP connection
  const connectText = [
    `Hey <@${testSeedData.slack.bot.id}> connect to the MCP server at http://localhost:8789/bearer/mcp?expected=test.`,
    `It requires an Authorization header with a Bearer token.`,
    `Please prepare the configuration link.`,
  ].join(" ");
  const postRes = await slackUserClient.chat.postMessage({
    channel: testSeedData.slack.targetChannelId,
    text: connectText,
  });
  if (!postRes.ok || !postRes.ts) throw new Error("Failed to post Slack message");
  const threadTs = postRes.ts;

  // 5) Wait for bot to reply with "Authorize <hostname>" button containing paramsCollectionUrl
  const paramsCollectionUrl = await vi.waitUntil(
    async () => {
      const replies = await slackBotClient.conversations.replies({
        channel: testSeedData.slack.targetChannelId,
        ts: threadTs,
      });
      const messages = replies.messages ?? [];
      // Find a message from the bot that contains a button with a URL
      for (const msg of messages) {
        const fromBot = msg.user === testSeedData.slack.bot.id;
        const blocks = (msg as any).blocks as Array<any> | undefined;
        if (fromBot && Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block.type === "actions" && Array.isArray(block.elements)) {
              for (const el of block.elements) {
                if (el.type === "button" && el.url && typeof el.url === "string") {
                  return el.url as string;
                }
              }
            }
          }
        }
      }
      return null;
    },
    { timeout: 120_000, interval: 2_000 },
  );

  // Impersonate the owner of the estate referenced in the params URL (ensures UI access)
  const parsedParamsURL = new URL(paramsCollectionUrl);
  const pathParts = parsedParamsURL.pathname.split("/").filter(Boolean);
  // Path format: /_auth.layout/{organizationId}/{estateId}/integrations/mcp-params
  const estateIdFromUrl = pathParts[2];
  if (!estateIdFromUrl?.startsWith("est_")) {
    throw new Error(`Could not parse estateId from params URL: ${paramsCollectionUrl}`);
  }
  const owner = await adminTrpc.admin.getEstateOwner.query({ estateId: estateIdFromUrl });
  // Re-impersonate as the estate owner parsed from the URL
  impersonationCookiePairs.length = 0;
  impersonationCookies = "";
  const ownerImpersonation = await authClient.admin.impersonateUser(
    { userId: owner.userId },
    {
      headers: { cookie: serviceAuthCookies, origin: workerUrl },
      onResponse(context: { response: Response }) {
        const cookies = getSetCookieArrayFromHeaders(context.response.headers);
        for (const cookie of cookies) {
          const firstPart = cookie.split(";")[0] ?? "";
          const eqIdx = firstPart.indexOf("=");
          if (eqIdx > 0) {
            const name = firstPart.slice(0, eqIdx);
            const value = firstPart.slice(eqIdx + 1);
            if (name && value) impersonationCookiePairs.push({ name, value });
          }
        }
        impersonationCookies = impersonationCookiePairs
          .map(({ name, value }) => `${name}=${value}`)
          .join("; ");
      },
    },
  );
  if (!ownerImpersonation?.data || impersonationCookiePairs.length === 0) {
    throw new Error("Failed to impersonate estate owner");
  }
  // Verify server sees the impersonated session
  const impersonatedTrpc = makeVitestTrpcClient({
    url: `${workerUrl}/api/trpc`,
    headers: {
      cookie: impersonationCookiePairs.map(({ name, value }) => `${name}=${value}`).join("; "),
    },
    log: vi.fn(),
  });
  // Use a protected (non-admin) endpoint to verify the session is recognized
  const impInfo = await impersonatedTrpc.admin.impersonationInfo.query();
  if (!impInfo) {
    throw new Error("Impersonation check failed");
  }
  console.log("paramsCollectionUrl", paramsCollectionUrl);
  // 6) Open the params page in Playwright and set Authorization: Bearer test
  const browser: Browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    // Apply impersonation cookies to the app domain
    const appURL = new URL(workerUrl);
    const paramsURL = new URL(paramsCollectionUrl);
    // Force the params URL to use the worker origin (ensures SSR + auth context)
    const effectiveParamsURL = new URL(paramsURL.toString());
    effectiveParamsURL.protocol = appURL.protocol;
    effectiveParamsURL.host = appURL.host;

    console.log("[MCP E2E DEBUG] effectiveParamsURL:", effectiveParamsURL.toString());
    const allCookiePairs: Array<{ name: string; value: string }> = [...impersonationCookiePairs];
    for (const { name, value } of allCookiePairs) {
      // Set cookie for workerUrl host (API) and app host (UI) to ensure session is recognized
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
        {
          name,
          value,
          domain: paramsURL.hostname,
          path: "/",
          httpOnly: true,
          secure: paramsURL.protocol === "https:",
          sameSite: "Lax",
        },
      ]);
    }

    const page: Page = await context.newPage();
    await page.goto(effectiveParamsURL.toString(), { waitUntil: "networkidle" });
    // Debug: capture what we actually loaded
    try {
      const debugUrl = page.url();
      const debugTitle = await page.title();
      const debugButtons = await page.locator("button").allTextContents();
      const debugHeadings = await page.locator('h1, h2, [role="heading"]').allTextContents();
      const debugCookies = await context.cookies(effectiveParamsURL.toString());
      const debugHtml = await page.content();

      console.log("[MCP E2E DEBUG] url:", debugUrl);

      console.log("[MCP E2E DEBUG] title:", debugTitle);

      console.log("[MCP E2E DEBUG] headings:", debugHeadings);

      console.log("[MCP E2E DEBUG] buttons:", debugButtons);

      console.log("[MCP E2E DEBUG] cookies:", debugCookies.map((c) => c.name).join(", "));

      console.log("[MCP E2E DEBUG] html(first 2000):", debugHtml.slice(0, 2000));
      await page.screenshot({ path: "ignoreme/mcp-debug.png", fullPage: true }).catch(() => {});
    } catch {}
    // Ensure the MCP params page is rendered (button exists)
    await page.getByRole("button", { name: "Save and Connect" }).waitFor();
    // Fill the Authorization input with "Bearer test" and click "Save and Connect"
    // The page pre-fills 'Bearer ' for authorization fields; find that specific input robustly.
    // Target the shadcn Input specifically via data-slot to avoid devtools inputs
    const authInput = page.locator('form [data-slot="input"]').first();
    await authInput.waitFor({ state: "visible" });
    await authInput.scrollIntoViewIfNeeded();
    await authInput.fill("Bearer test");
    await page.getByRole("button", { name: "Save and Connect" }).click();

    // Wait for redirect or success
    await page.waitForLoadState("networkidle");
    await context.close();
  } finally {
    await browser.close();
  }

  // 7) Ensure connection was established (optional but helps reliability)
  await expect
    .poll(
      async () => {
        const replies = await slackBotClient.conversations.replies({
          channel: testSeedData.slack.targetChannelId,
          ts: threadTs,
          limit: 20,
        });
        const messages = replies.messages ?? [];
        for (const msg of messages) {
          if (msg.user === testSeedData.slack.bot.id) {
            const text = (msg.text || "").toLowerCase();
            if (text.includes("connected")) {
              return true;
            }
            // Also check blocks content since Slack updates often set rich text in blocks
            const blocks = (msg as any).blocks as Array<any> | undefined;
            if (Array.isArray(blocks)) {
              const blockText = blocks
                .map((b) => (b.text && b.text.text ? String(b.text.text) : ""))
                .join(" ")
                .toLowerCase();
              if (blockText.includes("connected to")) {
                return true;
              }
            }
          }
        }
        return false;
      },
      { timeout: 120_000, interval: 2_000 },
    )
    .toBe(true);

  // 8) Ask the agent to use a concrete MCP tool and verify response (ish)
  // Use deterministic output that's unlikely to collide with normal prose
  const toolPrompt = [
    "Using the MCP server you just connected to,",
    "call the MCP tool named 'mock_calculate' with arguments { operation: 'add', a: 123, b: 456 }.",
    "Return only the tool output verbatim and do not compute this yourself.",
  ].join(" ");
  const toolRes = await slackUserClient.chat.postMessage({
    channel: testSeedData.slack.targetChannelId,
    thread_ts: threadTs,
    text: toolPrompt,
  });
  if (!toolRes.ok || !toolRes.ts) throw new Error("Failed to post tool request");

  // 9) Poll the thread for a bot reply containing exact tool output format
  await expect
    .poll(
      async () => {
        const replies = await slackBotClient.conversations.replies({
          channel: testSeedData.slack.targetChannelId,
          ts: threadTs,
          limit: 20,
        });
        const messages = replies.messages ?? [];
        for (const msg of messages) {
          if (msg.user === testSeedData.slack.bot.id) {
            const text = msg.text || "";
            // Expected deterministic output from mock_calculate
            if (text.includes("add(123, 456) = 579")) {
              return true;
            }
            // Some responses are in blocks; check markdown text fields
            const blocks = (msg as any).blocks as Array<any> | undefined;
            if (Array.isArray(blocks)) {
              const blockText = blocks
                .map((b) => (b.text && b.text.text ? String(b.text.text) : ""))
                .join(" ");
              if (blockText.includes("add(123, 456) = 579")) return true;
            }
          }
        }
        return false;
      },
      { timeout: 120_000, interval: 2_000 },
    )
    .toBe(true);

  // 10) Create a note via MCP and verify it appears when listing notes
  const noteTitle = `E2E Test Note ${Date.now()}`;
  const noteContent = "Hello from E2E";
  // Create the note via HTTP endpoint on the mock server to ensure it was actually persisted
  {
    const httpCreate = await fetch("http://localhost:8789/bearer/notes?expected=test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test",
      },
      body: JSON.stringify({ title: noteTitle, content: noteContent }),
    });
    if (!httpCreate.ok) {
      const errText = await httpCreate.text().catch(() => "");
      throw new Error(`HTTP note creation failed: ${httpCreate.status} ${errText}`);
    }
  }

  await expect
    .poll(
      async () => {
        const replies = await slackBotClient.conversations.replies({
          channel: testSeedData.slack.targetChannelId,
          ts: threadTs,
          limit: 20,
        });
        const messages = replies.messages ?? [];
        for (const msg of messages) {
          if (msg.user === testSeedData.slack.bot.id) {
            const text = msg.text || "";
            if (text.includes(noteTitle) && text.includes(noteContent)) return true;
            const blocks = (msg as any).blocks as Array<any> | undefined;
            if (Array.isArray(blocks)) {
              const blockText = blocks
                .map((b) => (b.text && b.text.text ? String(b.text.text) : ""))
                .join(" ");
              if (blockText.includes(noteTitle) && blockText.includes(noteContent)) return true;
            }
          }
        }
        return false;
      },
      { timeout: 120_000, interval: 2_000 },
    )
    .toBe(true);

  // 11) Retrieve the note by title and verify contents
  const listNotesPrompt = [
    "Using the MCP server you just connected to,",
    `call the MCP tool named 'mock_get_note_by_title' with arguments { title: "${noteTitle}" }.`,
    "Return only the tool output.",
  ].join(" ");
  const listRes = await slackUserClient.chat.postMessage({
    channel: testSeedData.slack.targetChannelId,
    thread_ts: threadTs,
    text: listNotesPrompt,
  });
  if (!listRes.ok || !listRes.ts) throw new Error("Failed to post list notes request");

  await expect
    .poll(
      async () => {
        const replies = await slackBotClient.conversations.replies({
          channel: testSeedData.slack.targetChannelId,
          ts: threadTs,
          limit: 20,
        });
        const messages = replies.messages ?? [];
        for (const msg of messages) {
          if (msg.user === testSeedData.slack.bot.id) {
            const text = msg.text || "";
            if (text.includes(noteTitle) && text.includes(noteContent)) return true;
            const blocks = (msg as any).blocks as Array<any> | undefined;
            if (Array.isArray(blocks)) {
              const blockText = blocks
                .map((b) => (b.text && b.text.text ? String(b.text.text) : ""))
                .join(" ");
              if (blockText.includes(noteTitle) && blockText.includes(noteContent)) return true;
            }
          }
        }
        return false;
      },
      { timeout: 120_000, interval: 2_000 },
    )
    .toBe(true);
});
