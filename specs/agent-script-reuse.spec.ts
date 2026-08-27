import dedent from "dedent";
import { spinnerWaiter } from "middlewright";
import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

// Script reuse (itx.capabilityHost.previousScriptHelper) through the real
// chat UI, deterministically: the "model" is this spec's own interceptor,
// serving the inline scripts below keyed by the user message. Both turns'
// scripts EXECUTE for real — the child run re-runs turn 1's algorithm with
// the new number — and the spec opens each turn's codemode snippet in the
// feed to show the shortcut.
// Quarantined with tasks/platform-stall-repros.md: on 2026-08-27 this spec
// failed 3/3 consecutive preview runs (Depot w1hcwnlc3q, bqk06tf2kc,
// p2blkx8cx5) — including runs of THIS spec text with its warm-up turn
// intact, one of them stalling on turn 2. The journals show the turns
// complete in 150-183s: the in-flight intercepted LLM request is severed by
// processor eviction churn, and a hung re-dial is invisible until a 30-40s
// staleness wake (the expected-fail spec in
// apps/os/src/domains/agents/agent-llm-stall.test.ts pins the mechanism).
// Un-skip when attempt-progress deadlines land (that task's fix direction,
// threads 1-2) and a preview run passes with the warm-up REMOVED (#2529).
test.skip("a repeat request reuses the previous turn's journaled script instead of re-deriving it", async ({
  helpers,
  page,
  baseURL,
}) => {
  await using fixture = await helpers.createFixture("agent-script-reuse");
  if (!baseURL) throw new Error("Playwright baseURL fixture is required.");

  using admin = await connectAdminItx(baseURL);
  using project = admin.projects.get(fixture.project.id);
  const agentPath = `/agents/factorizer-${crypto.randomUUID().slice(0, 8)}`;
  using agent = project.agents.get(agentPath);
  await agent.create();
  await agent.append({
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model: "intercepted/factorizer" }, llmRequestDebounceMs: 250 } },
  });

  const scripts: Record<string, string> = {
    "warm up": dedent`
      async (itx) => {
        await itx.chat.sendMessage("warmed");
      }
    `,
    "prime factorize": dedent`
      async (itx) => {
        const n = 52479543428582704627n;
        const gcd = (a: bigint, b: bigint): bigint => {
          while (b) [a, b] = [b, a % b];
          return a;
        };
        const modPow = (a: bigint, e: bigint, m: bigint): bigint => {
          let r = 1n;
          a %= m;
          while (e > 0n) {
            if (e & 1n) r = (r * a) % m;
            a = (a * a) % m;
            e >>= 1n;
          }
          return r;
        };
        const isPrime = (x: bigint): boolean => {
          if (x < 2n) return false;
          for (const p of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) {
            if (x === p) return true;
            if (x % p === 0n) return false;
          }
          let d = x - 1n;
          let s = 0;
          while ((d & 1n) === 0n) {
            d >>= 1n;
            s++;
          }
          for (const a of [2n, 325n, 9375n, 28178n, 450775n, 9780504n, 1795265022n]) {
            if (a % x === 0n) continue;
            let y = modPow(a, d, x);
            if (y === 1n || y === x - 1n) continue;
            let composite = true;
            for (let r = 1; r < s; r++) {
              y = (y * y) % x;
              if (y === x - 1n) {
                composite = false;
                break;
              }
            }
            if (composite) return false;
          }
          return true;
        };
        const rho = (x: bigint): bigint => {
          if (x % 2n === 0n) return 2n;
          for (let c = 1n; ; c++) {
            const f = (v: bigint) => (v * v + c) % x;
            let a = 2n, b = 2n, d = 1n;
            while (d === 1n) {
              a = f(a);
              b = f(f(b));
              d = gcd(a > b ? a - b : b - a, x);
            }
            if (d !== x) return d;
          }
        };
        const factors: bigint[] = [];
        const split = (x: bigint): void => {
          if (x === 1n) return;
          if (isPrime(x)) {
            factors.push(x);
            return;
          }
          const d = rho(x);
          split(d);
          split(x / d);
        };
        split(n);
        factors.sort((p, q) => (p < q ? -1 : 1));
        await itx.chat.sendMessage(\`\${n} = \${factors.join(" × ")}\`);
      }
    `,
    "now do": dedent`
      async (itx) => {
        const helper = await itx.capabilityHost.previousScriptHelper({
          ...results[0],
          parameterize: { n: 52479543428582704627n },
        });
        await helper.run({ n: 66778601389380731119n });
      }
    `,
  };
  await using _interception = await fixture.interceptAi(async (call) => {
    if (call.source !== "agent-turn") throw new Error(`unexpected source: ${call.source}`);
    const lastUser = [...call.body.messages].reverse().find((m) => m.role === "user");
    const entry = Object.entries(scripts).find(([key]) => lastUser?.content.includes(key));
    if (!entry) throw new Error(`no scripted reply matches: ${lastUser?.content.slice(0, 80)}`);
    return ["```ts", entry[1], "```"].join("\n");
  });

  // Absorb the cold-deployment cost before the UI assertions: the FIRST
  // intercepted turn on a fresh deployment runs 35-65s of platform churn; a
  // throwaway agent takes that hit at the itx level, where waits carry no
  // playwright budget.
  const warmPath = `/agents/warm-${crypto.randomUUID().slice(0, 8)}`;
  using warmAgent = project.agents.get(warmPath);
  await warmAgent.create();
  await warmAgent.append({
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model: "intercepted/factorizer" }, llmRequestDebounceMs: 250 } },
  });
  await warmAgent.ask({ message: "warm up", timeoutMs: 90_000 }).catch(() => {});

  await page.goto(`/projects/${fixture.project.slug}/agents/streams${agentPath}`);
  const composer = page.getByPlaceholder("Message this agent");
  const send = page.getByRole("button", { name: "Send message" });

  // Turn 1: the long way. The script really runs; the answer is computed.
  // The working indicator stays up while the turn runs server-side — a slow
  // turn is healthy, so give the spinner more room instead of failing it.
  await spinnerWaiter.settings.run({ spinnerTimeout: 60_000 }, async () => {
    await composer.fill("prime factorize 52479543428582704627");
    await send.click();
    await page.getByText("52479543428582704627 = 6203868971 × 8459163737").waitFor();
  });

  // Turn 2: the reused way. The child run executes turn 1's algorithm with
  // the new number — the correct product proves real execution, not prose.
  await spinnerWaiter.settings.run({ spinnerTimeout: 60_000 }, async () => {
    await composer.fill("now do 66778601389380731119");
    await send.click();
    await page.getByText("66778601389380731119 = 7316102869 × 9127619251").waitFor();
  });

  // Open turn 1's codemode snippet: the full derived algorithm.
  const activities = page.getByRole("button", { name: /Ran code/ });
  await activities.first().click();
  const firstScript = page.locator(".cm-content").first();
  await firstScript.waitFor();
  await firstScript
    .locator(".cm-line", { hasText: "const n = 52479543428582704627n" })
    .first()
    .waitFor();
  await firstScript.locator(".cm-line", { hasText: "modPow" }).first().waitFor();
  await activities.first().click(); // collapse again before opening turn 2

  // Open turn 2's snippet: a few lines reusing results[0].
  await activities.nth(1).click();
  const reuseRound = page.getByTestId("agent-feed-round");
  if (await reuseRound.count()) await reuseRound.first().click();
  const secondScript = page.locator(".cm-content").first();
  await secondScript.waitFor();
  await secondScript
    .locator(".cm-line", { hasText: "parameterize: { n: 52479543428582704627n }" })
    .first()
    .waitFor();
  // The reuse turn's script must not carry the algorithm, so with turn 1
  // collapsed no rendered line may mention modPow — absence IS the assertion,
  // hence this exceptional detached wait.
  await page.locator(".cm-line", { hasText: "modPow" }).first().waitFor({ state: "detached" });
});

// The typed-return sibling: turn 1's first script RETURNS its factors (so a
// `data` row with the literal tuple type lands in `results`), a second round
// sends the message from results[0].data, and turn 2 reuses the factorize
// row with `satisfies` assertions INSIDE the codemode script — the real
// typecheck gate, compiling against the real preamble, is the assertion
// engine. Turn 2 deliberately runs TWO scripted attempts: the first asserts
// `satisfies readonly number[]` and the gate MUST reject it (if run()'s
// inference ever degraded to `any`, the satisfies would pass, that script
// would run and end the turn, and the final message — which only the second
// attempt sends — would never arrive); the corrective retry asserts
// `readonly string[]` and passes. `satisfies`, not annotations: gate policy
// blocks only provable errors (syntax + near-miss typos), and satisfies
// failures are TS1360, in the syntax range — plain TS2322 annotation
// mismatches deliberately never block.
// Quarantined with tasks/platform-stall-repros.md — same churn-wedge class
// as the first test (this one failed 1/3 of the 2026-08-27 preview runs, at
// turn 2, past its warm-up); same exit criteria.
test.skip("run() return values are typed from the reused row's data, through the real gate", async ({
  helpers,
  page,
  baseURL,
}) => {
  await using fixture = await helpers.createFixture("agent-script-reuse-typed");
  if (!baseURL) throw new Error("Playwright baseURL fixture is required.");

  using admin = await connectAdminItx(baseURL);
  using project = admin.projects.get(fixture.project.id);
  const agentPath = `/agents/typed-${crypto.randomUUID().slice(0, 8)}`;
  using agent = project.agents.get(agentPath);
  await agent.create();
  await agent.append({
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model: "intercepted/typed" }, llmRequestDebounceMs: 250 } },
  });

  const nowDoQueue = [
    // Attempt 1 — the wrong satisfies; the gate must reject it and the
    // marker message must never send. results[1]: results[0] is the
    // send-result round's done row.
    dedent`
      async (itx) => {
        const helper = await itx.capabilityHost.previousScriptHelper({
          ...results[1],
          parameterize: { n: 8633n },
        });
        const result = await helper.run({ n: 10403n });
        result satisfies readonly number[];
        await itx.chat.sendMessage(\`this should never send: \${result}\`);
      }
    `,
    // Attempt 2 (after the gate's corrective feedback) — the satisfies
    // matching the inferred type passes. results[2], not [1]: attempt 1's
    // rejection settled as an ERROR row, shifting positions — the drift
    // results.byOffset absorbs; a scripted retry can just count.
    dedent`
      async (itx) => {
        const helper = await itx.capabilityHost.previousScriptHelper({
          ...results[2],
          parameterize: { n: 8633n },
        });
        const result = await helper.run({ n: 10403n });
        result satisfies readonly string[];
        await itx.chat.sendMessage(\`Result is \${result.join(" × ")}\`);
      }
    `,
  ];
  const scriptQueues: Record<string, string[]> = {
    "warm up": [
      dedent`
        async (itx) => {
          await itx.chat.sendMessage("warmed");
        }
      `,
    ],
    "prime factorize": [
      // Round 1: RETURN the factors (JSON-serializable, so strings —
      // bigints do not survive result serialization); the returned value
      // becomes a data row typed by its literal.
      dedent`
        async (itx) => {
          const target = 8633n;
          let remaining = target;
          const factors: bigint[] = [];
          for (let candidate = 2n; candidate * candidate <= remaining; candidate += 1n) {
            while (remaining % candidate === 0n) {
              factors.push(candidate);
              remaining /= candidate;
            }
          }
          if (remaining > 1n) factors.push(remaining);
          return factors.map(String);
        }
      `,
      // Round 2: the settlement made the value results[0].data — send it.
      dedent`
        async (itx) => {
          await itx.chat.sendMessage(\`factors of 8633: \${results[0].data.join(" × ")}\`);
        }
      `,
    ],
    "now do": nowDoQueue,
  };
  await using _interception = await fixture.interceptAi(async (call) => {
    if (call.source !== "agent-turn") throw new Error(`unexpected source: ${call.source}`);
    const lastUser = [...call.body.messages].reverse().find((m) => m.role === "user");
    const entry = Object.entries(scriptQueues).find(([key]) => lastUser?.content.includes(key));
    if (!entry) throw new Error(`no scripted reply matches: ${lastUser?.content.slice(0, 80)}`);
    const queue = entry[1];
    // Consume one per model call; the last entry repeats so re-asks cannot
    // crash the router.
    return ["```ts", queue.length > 1 ? queue.shift()! : queue[0]!, "```"].join("\n");
  });

  const warmPath = `/agents/warm-${crypto.randomUUID().slice(0, 8)}`;
  using warmAgent = project.agents.get(warmPath);
  await warmAgent.create();
  await warmAgent.append({
    type: "events.iterate.com/agent/configured",
    payload: { config: { llm: { model: "intercepted/typed" }, llmRequestDebounceMs: 250 } },
  });
  await warmAgent.ask({ message: "warm up", timeoutMs: 90_000 }).catch(() => {});

  await page.goto(`/projects/${fixture.project.slug}/agents/streams${agentPath}`);
  const composer = page.getByPlaceholder("Message this agent");
  const send = page.getByRole("button", { name: "Send message" });

  await spinnerWaiter.settings.run({ spinnerTimeout: 60_000 }, async () => {
    await composer.fill("prime factorize 8633");
    await send.click();
    await page.getByText("factors of 8633: 89 × 97").waitFor();
  });
  await spinnerWaiter.settings.run({ spinnerTimeout: 60_000 }, async () => {
    await composer.fill("now do 10403");
    await send.click();
    await page.getByText("Result is 101 × 103").waitFor();
  });
  // The wrong attempt was consumed (the router keeps only the repeatable
  // last entry) — the gate really rejected it and the agent loop delivered
  // the corrective retry, which alone sends the final message.
  if (nowDoQueue.length !== 1) {
    throw new Error(`expected only the corrective retry to remain; ${nowDoQueue.length} left`);
  }
});
