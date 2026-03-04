import dedent from "dedent";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Plugin, ActionContext } from "../playwright-plugin.ts";
import { adjustError } from "../playwright-plugin.ts";

export type LlmRecoverOptions = {
  /** Max recovery attempts per failing action. Default: 3 */
  maxAttempts?: number;
  /** Anthropic model to use. Default: "claude-sonnet-4-20250514" */
  model?: string;
  /** Max tokens for LLM response. Default: 4096 */
  maxTokens?: number;
  /** Whether to include page HTML (truncated) in the prompt. Default: true */
  includeHtml?: boolean;
  /** Max HTML length to send. Default: 50_000 */
  maxHtmlLength?: number;
  /** Override the LLM call for testing. Return JS function body string, or null to rethrow. */
  requestRecoveryCode?: RequestRecoveryCodeFn;
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
};

export type RequestRecoveryCodeFn = (
  context: RecoveryContext,
  attemptHistory: AttemptRecord[],
) => Promise<string | null>;

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

        const { page, locator, method, args, testInfo } = ctx;
        const attemptHistory: AttemptRecord[] = [];

        // Gather context once (screenshot + HTML don't change between LLM retries
        // unless recovery code navigates, but that's fine — we capture at failure time)
        const context = await gatherContext(ctx, originalError, options);

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          let code: string | null;
          try {
            code = await requestRecovery(context, attemptHistory);
          } catch (llmError) {
            // LLM call itself failed — don't retry, just throw original
            adjustError(
              originalError,
              [
                `[llm-recover] LLM call failed: ${llmError instanceof Error ? llmError.message : String(llmError)}`,
              ],
              import.meta.filename,
            );
            throw originalError;
          }

          // null/empty = rethrow as-is
          if (!code || code.trim() === "") {
            throw originalError;
          }

          const start = Date.now();
          try {
            // The LLM returns either:
            // 1. `async function recover({ page, locator, error }) { ... }` (preferred)
            // 2. A bare function body (legacy)
            // We wrap it so both forms work: define the function, then call it.
            // eslint-disable-next-line no-eval -- intentional: LLM codemode recovery
            const recoveryFn = new Function(
              "page",
              "locator",
              "error",
              `${code}\nreturn recover({ page, locator, error });`,
            );
            // Mark page as in-recovery so nested locator failures don't re-trigger LLM
            pagesInRecovery.add(page);
            try {
              await recoveryFn(page, locator, originalError);
            } finally {
              pagesInRecovery.delete(page);
            }

            // Recovery succeeded — record a soft error so the test is marked
            // failed but continues executing. We push directly to testInfo.errors
            // because the global `expect.soft` only works inside a test context.
            if (testInfo) {
              const description = code.length > 200 ? code.slice(0, 200) + "..." : code;
              testInfo.errors.push({
                message: [
                  `[llm-recover] ${locator}.${method}() failed and was recovered by LLM.`,
                  `Original error: ${originalError.message.split("\n")[0]}`,
                  `Recovery code:\n${description}`,
                ].join("\n"),
              });
            }

            // Write artifact
            writeArtifact(testInfo, {
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
  const includeHtml = options.includeHtml ?? true;
  const maxHtmlLength = options.maxHtmlLength ?? 50_000;

  // Screenshot
  let screenshotBase64: string | null = null;
  try {
    const buffer = await page.screenshot({ type: "png" });
    screenshotBase64 = buffer.toString("base64");
  } catch {
    // page may be crashed/closed
  }

  // HTML
  let html: string | null = null;
  if (includeHtml) {
    try {
      const content = await page.content();
      html =
        content.length > maxHtmlLength
          ? content.slice(0, maxHtmlLength) + "\n<!-- truncated -->"
          : content;
    } catch {
      // page may be crashed/closed
    }
  }

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
  if (!testInfo) return;
  try {
    const dir = path.join(testInfo.outputDir, "llm-recover");
    fs.mkdirSync(dir, { recursive: true });
    const filename = `attempt-${Date.now()}.json`;
    fs.writeFileSync(path.join(dir, filename), JSON.stringify(data, null, 2));
  } catch {
    // best-effort
  }
}

// --- Anthropic provider ---

const SYSTEM_PROMPT = dedent`
  You are a Playwright test recovery assistant. A locator action failed during a test. You will be given:

  - The test name and file
  - The failing line of code
  - The locator and method that failed
  - The error message and stack trace
  - A screenshot of the page at the time of failure
  - Optionally, the page HTML

  Your job: respond with a JavaScript function body, wrapped by \`<code>...\<\/code>\` tags. It must be an async function named \`recover\` that takes a single context argument:

  <code>
  async function recover({ page, locator, error }){
    await page.locator(".some-other-selector").click();
  }
  </code>

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

  If the failure is UNRECOVERABLE (e.g. the test logic is fundamentally wrong, not a locator/timing issue), throw \`error\` or throw a new Error with a helpful message explaining what's wrong:

  <code>
  async function recover({ error }) {
    throw error;
  }
  </code>

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
  const apiKey = process.env.ANTHROPIC_API_KEY;
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
    ];

    if (context.html) {
      textParts.push(
        `**Page HTML (possibly truncated):**\n\`\`\`html\n${context.html.slice(0, 20_000)}\n\`\`\``,
      );
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
function extractCode(text: string): string | null {
  let code = text.trim();

  // Extract from <code>...</code> tags (preferred format)
  const codeTagMatch = code.match(/<code>([\s\S]*?)<\/code>/);
  if (codeTagMatch) {
    code = codeTagMatch[1].trim();
  }

  // Strip markdown fences if present
  if (code.startsWith("```")) {
    code = code.replace(/^```(?:js|javascript|typescript|ts)?\n?/, "").replace(/\n?```$/, "");
  }

  return code || null;
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
