import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import dedent from "dedent";
import { expect as playwrightExpect } from "@playwright/test";
import type { Plugin, ActionContext } from "../playwright-plugin.ts";
import { adjustError } from "../playwright-plugin.ts";

export type LlmRecoverOptions = {
  /** Max recovery attempts per failing action. Default: 3 */
  maxAttempts?: number;
  /** Anthropic model to use. Default: "claude-sonnet-4-20250514" */
  model?: string;
  /** Max tokens for LLM response. Default: 4096 */
  maxTokens?: number;
  /** Max HTML length to send. Default: 50_000 */
  maxHtmlLength?: number;
  /** Override the LLM call for testing. Return JS function body string, or null to rethrow. */
  requestRecoveryCode?: RequestRecoveryCodeFn;
  expect?: typeof playwrightExpect;
};

export type AttemptRecord = {
  code: string;
  error: string;
  durationMs: number;
};

export type RecoveryContext = {
  testTitle: string;
  testFile: string;
  failingLine: string;
  locatorString: string;
  method: string;
  args: string;
  errorMessage: string;
  errorStack: string;
  screenshotBase64: string | null;
  html: string | null;
  accessibilitySnapshotYaml: string | null;
};

export type RequestRecoveryCodeFn = (
  context: RecoveryContext,
  attemptHistory: AttemptRecord[],
) => Promise<{ code: string | null; description: string } | null>;

/**
 * LLM-powered recovery plugin. When a locator action fails, captures context
 * (screenshot, error, test info) and asks an LLM to generate a JS recovery
 * function. The function is eval'd with { page, locator, error } in scope.
 *
 * Opt-in: only enabled when `LLM_RECOVER` env var is set.
 */
// Re-entrancy guard: don't try to recover failures that happen inside recovery code.
// Uses a WeakSet of pages currently being recovered.
const pagesInRecovery = new WeakSet<object>();

export const llmRecover = (options: LlmRecoverOptions = {}): Plugin => {
  const expect = options.expect ?? playwrightExpect;
  const maxAttempts = options.maxAttempts ?? 3;
  const requestRecovery = options.requestRecoveryCode ?? createAnthropicProvider(options);

  return {
    name: "llm-recover",

    middleware: async (ctx: ActionContext, next) => {
      // Skip if we're already inside a recovery attempt for this page
      if (pagesInRecovery.has(ctx.page)) return next();

      try {
        return await next();
      } catch (originalError) {
        if (!(originalError instanceof Error)) throw originalError;

        const { page, locator, method, testInfo } = ctx;
        const attemptHistory: AttemptRecord[] = [];

        // Gather context once (screenshot + HTML don't change between LLM retries
        // unless recovery code navigates, but that's fine — we capture at failure time)
        const context = await gatherContext(ctx, originalError, options);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          let recoveryResult: { code: string | null; description: string } | null;
          try {
            recoveryResult = await requestRecovery(context, attemptHistory);
          } catch (llmError) {
            // LLM call itself failed — don't retry, just throw original
            adjustError(
              originalError,
              [`[llm-recover] LLM call failed: ${String(llmError)}`],
              import.meta.filename,
            );
            throw originalError;
          }

          const code = recoveryResult?.code;
          // null/empty = rethrow as-is
          if (!code?.trim()) {
            adjustError(
              originalError,
              [`[llm-recover] LLM call returned no code: ${recoveryResult?.description}`],
              import.meta.filename,
            );
            throw originalError;
          }

          const start = Date.now();
          try {
            // eslint-disable-next-line no-unused-vars, no-unassigned-vars -- intentional: LLM codemode recovery
            let recoveryFn!: Function;
            // eslint-disable-next-line no-eval -- intentional: LLM codemode recovery
            eval(`recoveryFn = ${code.trim()}`);
            if (typeof recoveryFn !== "function") {
              adjustError(
                originalError,
                [`[llm-recover] Recovery function is not a function: ${code}`],
                import.meta.filename,
              );
              throw originalError;
            }
            // Mark page as in-recovery so nested locator failures don't re-trigger LLM
            pagesInRecovery.add(page);
            try {
              await recoveryFn({ page, locator, error: originalError });
            } finally {
              pagesInRecovery.delete(page);
            }

            // Write artifact
            const artifact = writeArtifact(testInfo, {
              test: context.testTitle,
              file: context.testFile,
              failingLine: context.failingLine,
              locator: context.locatorString,
              method,
              originalError: originalError.message,
              attempts: [
                ...attemptHistory,
                { code, error: "(success)", durationMs: Date.now() - start },
              ],
              recovered: true,
            });

            // Recovery succeeded — record a soft error so the test is marked
            // failed but continues executing. We push directly to testInfo.errors
            // because the global `expect.soft` only works inside a test context.
            const description = code.split("\n").slice(1, -1).join("\n");
            const message = [
              `[llm-recover] ${method} failed and was recovered by LLM.`,
              `Original error:\n  ${originalError.message.split("\n")[0]}`,
              `Original locator:\n  await page.${locator}.${method}()`,
              `Recovery code:\n${description}`,
              `Explanation::\n  ${recoveryResult?.description}`,
              `Artifact: ${artifact}`,
            ].join("\n");
            expect.soft("passed–after-llm-recovery", message).toBe("passed-in-the-first-place");

            return; // recovery complete
          } catch (recoveryError) {
            const errorMsg =
              recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
            attemptHistory.push({
              code,
              error: errorMsg,
              durationMs: Date.now() - start,
            });
            // loop continues
          }
        }

        // Exhausted all attempts — write artifact and rethrow
        writeArtifact(ctx.testInfo, {
          test: context.testTitle,
          file: context.testFile,
          failingLine: context.failingLine,
          locator: context.locatorString,
          method,
          originalError: originalError.message,
          attempts: attemptHistory,
          recovered: false,
        });

        const summary = attemptHistory.map((a, i) => `  Attempt ${i + 1}: ${a.error}`).join("\n");
        adjustError(
          originalError,
          [`[llm-recover] ${attemptHistory.length} recovery attempt(s) failed:`, summary],
          import.meta.filename,
        );
        throw originalError;
      }
    },
  };
};

async function gatherContext(
  ctx: ActionContext,
  error: Error,
  options: LlmRecoverOptions,
): Promise<RecoveryContext> {
  const { page, locator, method, args, testInfo } = ctx;
  const maxHtmlLength = options.maxHtmlLength ?? 50_000;

  // Screenshot
  const screenshotBase64 = await page
    .screenshot({ type: "png" })
    .then((buffer) => buffer.toString("base64"))
    .catch(() => null);

  // HTML
  const html = await page
    .content()
    .then((content) => {
      if (content.length < maxHtmlLength) return content;
      return content.slice(0, maxHtmlLength) + "\n<!-- truncated -->";
    })
    .catch(() => "<!-- HTML unavailable -->");

  // Accessibility snapshot (YAML)
  const accessibilitySnapshotYaml = await page
    .locator("body")
    .ariaSnapshot()
    .catch((e) => `<!-- accessibility snapshot unavailable (${e}) -->`);

  // Parse failing line from stack
  const failingLine = parseFailingLine(error.stack ?? "");

  return {
    testTitle: testInfo?.titlePath.join(" > ") ?? "(unknown test)",
    testFile: testInfo?.file ?? "(unknown file)",
    failingLine,
    locatorString: locator.toString(),
    method,
    args: JSON.stringify(args),
    errorMessage: error.message,
    errorStack: error.stack ?? "",
    screenshotBase64,
    html,
    accessibilitySnapshotYaml,
  };
}

function parseFailingLine(stack: string): string {
  const lines = stack.split("\n");
  for (const line of lines) {
    // Look for spec file frames, skip node_modules and plugin files
    if (line.includes(".spec.ts") && !line.includes("node_modules") && !line.includes("plugins/")) {
      return line.trim();
    }
  }
  // Fallback: first frame that's not node_modules
  for (const line of lines) {
    if (line.trim().startsWith("at ") && !line.includes("node_modules")) {
      return line.trim();
    }
  }
  return "(unknown)";
}

function writeArtifact(testInfo: ActionContext["testInfo"], data: Record<string, unknown>) {
  if (!testInfo) return "(no-test-info)";
  const dir = path.join(testInfo.outputDir, "llm-recover");
  fs.mkdirSync(dir, { recursive: true });
  const filename = `attempt-${Date.now()}.json`;
  const filepath = path.join(dir, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  return filepath;
}

// --- Anthropic provider ---

const SYSTEM_PROMPT = dedent`
  You are a Playwright test recovery assistant. A locator action failed during a test. You will be given:

  - The test name and file
  - The failing line of code
  - The locator and method that failed
  - The error message and stack trace
  - A screenshot of the page at the time of failure
  - An accessibility snapshot in YAML format (preferred source for element names/roles/states)
  - Optionally, the page HTML

  Your job: respond with a JavaScript function body, wrapped by \`<code>...\<\/code>\` tags. It must be an async function named \`recover\` that takes a single context argument:

  After the function definition, write a brief description of why the given recovery code was chosen. Sacrifice grammar for concision. Example:

  ---

  <code>
  async function recover({ page, locator, error }){
    await page.getByText("Create an account").click();
  }
  </code>

  The original locator looked for the text "Create account", but the DOM shows "Create an account" instead.

  ---

  Where the context passed in has the following type:

  \`\`\`ts
  type RecoveryContext = {
    /** The Playwright Page object, used by the test */
    page: import("@playwright/test").Page;
    /** The Locator that failed had a failing action */
    locator: import("@playwright/test").Locator;
    /** The original error thrown by the failing action */
    error: Error;
  };
  \`\`\`

  If the failure is UNRECOVERABLE (e.g. the test logic is fundamentally wrong, not a locator/timing issue), simply omit the <code>...</code> tags and return an explanation of why it's unrecoverable:

  ---

  Not recoverable: account creation is explicitly disabled in this UI.

  ---

  If the failure is RECOVERABLE, write code that:
  1. Performs any necessary setup (dismiss modals, wait for elements, scroll, etc.)
  2. Completes the action that the original locator was trying to do

  Common recovery patterns:
  - Wrong/stale locator: find the correct element and interact with it
  - Timing issue: wait for the right condition then retry
  - Modal/overlay blocking: dismiss it, then retry
  - Element not in viewport: scroll to it, then interact

  Keep the code minimal. Do not add unnecessary waits or retries.
`;

function createAnthropicProvider(options: LlmRecoverOptions): RequestRecoveryCodeFn {
  let apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    apiKey = execSync("doppler secrets get --plain ANTHROPIC_API_KEY").toString().trim();
  }
  if (!apiKey) {
    throw new Error(
      "[llm-recover] ANTHROPIC_API_KEY environment variable is required when LLM_RECOVER is enabled",
    );
  }

  const model = options.model ?? "claude-opus-4-6";
  const maxTokens = options.maxTokens ?? 4096;

  return async (context, attemptHistory) => {
    const userContent: AnthropicContent[] = [];

    // Text context
    const textParts = [
      `**Test:** ${context.testTitle}`,
      `**File:** ${context.testFile}`,
      `**Failing line:** ${context.failingLine}`,
      `**Locator:** ${context.locatorString}`,
      `**Method:** ${context.method}(${context.args})`,
      `**Error:** ${context.errorMessage}`,
      `**Stack:**\n\`\`\`\n${context.errorStack.slice(0, 2000)}\n\`\`\``,
      `**Accessibility snapshot (YAML):**\n\`\`\`yaml\n${context.accessibilitySnapshotYaml}\n\`\`\``,
    ];

    if (context.html) {
      const suffix = context.html.endsWith("<!-- truncated -->") ? " (truncated)" : "";
      textParts.push(`**Page HTML${suffix}:**\n\`\`\`html\n${context.html}\n\`\`\``);
    }

    if (attemptHistory.length > 0) {
      textParts.push(`**Previous recovery attempts (all failed):**`);
      for (const [i, attempt] of attemptHistory.entries()) {
        textParts.push(
          `Attempt ${i + 1} (${attempt.durationMs}ms):\nCode:\n\`\`\`js\n${attempt.code}\n\`\`\`\nError: ${attempt.error}`,
        );
      }
      textParts.push(`Try a DIFFERENT approach than what was already attempted.`);
    }

    userContent.push({ type: "text", text: textParts.join("\n\n") });

    // Screenshot
    if (context.screenshotBase64) {
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: context.screenshotBase64,
        },
      });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`Anthropic API error ${response.status}: ${body}`);
    }

    const data = (await response.json()) as AnthropicResponse;
    const textBlock = data.content?.find((b) => b.type === "text");
    if (!textBlock?.text) return null;

    return extractCode(textBlock.text);
  };
}

/** Extract code from LLM response. Handles <code>...</code> tags and markdown fences. */
function extractCode(text: string): { code: string | null; description: string } {
  text = text.trim();
  const codeStart = text.indexOf("<code>");
  const codeEnd = text.indexOf("</code>");
  if (codeStart === -1 || codeEnd === -1) {
    return { code: null, description: text };
  }
  const code = text.slice(codeStart + 6, codeEnd).trim() || null;
  const description = [text.slice(0, codeStart).trim(), text.slice(codeEnd + 7).trim()]
    .filter(Boolean)
    .join("\n\n");
  return { code, description };
}

// Minimal Anthropic API types (avoid importing the SDK)
type AnthropicContent =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string };
    };

type AnthropicResponse = {
  content: Array<{ type: string; text?: string }>;
};
