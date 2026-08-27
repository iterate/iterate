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
// UN-QUARANTINED here (was skipped with tasks/platform-stall-repros.md after
// failing 3/3 preview runs on 2026-08-27): the attempt-progress watchdog on
// this branch bounds a churn-severed turn, and this PR's preview runs — with
// the warm-up turn REMOVED — are the quarantine's own exit-criteria proof.
test("a repeat request reuses the previous turn's journaled script instead of re-deriving it", async ({
  helpers,
  page,
  baseURL,
}) => {
  // Turn 1 wears the whole cold-deployment cost on the clock (see its
  // spinner budget below), so the default 90s spec budget cannot hold the
  // full flow — heavy tier, same as agent-chat.spec.ts.
  test.setTimeout(240_000);
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

  await page.goto(`/projects/${fixture.project.slug}/agents/streams${agentPath}`);
  const composer = page.getByPlaceholder("Message this agent");
  const send = page.getByRole("button", { name: "Send message" });

  // Turn 1: the long way. The script really runs; the answer is computed.
  // The working indicator stays up while the turn runs server-side — a slow
  // turn is healthy, so give the spinner more room instead of failing it.
  // This turn also pays the deployment's one-time cold costs (DO spin-up +
  // journal hydration, the tswasm sidecar's first compile, dynamic isolate
  // creation — 35-65s on a fresh preview), hence the doubled budget here
  // only. The spinner-waiter keeps this honest: it bails the moment the
  // working indicator disappears, so the wide budget never hides a blank UI.
  await spinnerWaiter.settings.run({ spinnerTimeout: 120_000 }, async () => {
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
// UN-QUARANTINED here alongside the first test (same churn-wedge class, same
// exit criteria — the watchdog on this branch). This test keeps its warm-up
// turn: removing it is a follow-up once the first test's warm-up-free shape
// proves out on preview.
test("run() return values are typed from the reused row's data, through the real gate", async ({
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

  const warmUpScript = dedent`
    async (itx) => {
      await itx.chat.sendMessage("warmed");
    }
  `;
  // Round 1: RETURN the factors (JSON-serializable, so strings — bigints do
  // not survive result serialization); the returned value becomes a data row
  // typed by its literal.
  const factorizeScript = dedent`
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
  `;
  // Round 2: the settlement made the value results[0].data — send it.
  const sendFactorsScript = dedent`
    async (itx) => {
      await itx.chat.sendMessage(\`factors of 8633: \${results[0].data.join(" × ")}\`);
    }
  `;
  // Attempt 1 — the wrong satisfies; the gate must reject it and the marker
  // message must never send. results[1]: results[0] is the send-result
  // round's done row.
  const wrongSatisfiesScript = dedent`
    async (itx) => {
      const helper = await itx.capabilityHost.previousScriptHelper({
        ...results[1],
        parameterize: { n: 8633n },
      });
      const result = await helper.run({ n: 10403n });
      result satisfies readonly number[];
      await itx.chat.sendMessage(\`this should never send: \${result}\`);
    }
  `;
  // Attempt 2 (after the gate's corrective feedback) — the satisfies
  // matching the inferred type passes. results[2], not [1]: attempt 1's
  // rejection settled as an ERROR row, shifting positions — the drift
  // results.byOffset absorbs; a scripted retry can just count.
  const correctSatisfiesScript = dedent`
    async (itx) => {
      const helper = await itx.capabilityHost.previousScriptHelper({
        ...results[2],
        parameterize: { n: 8633n },
      });
      const result = await helper.run({ n: 10403n });
      result satisfies readonly string[];
      await itx.chat.sendMessage(\`Result is \${result.join(" × ")}\`);
    }
  `;
  const wrongAttemptServes = { count: 0 };
  await using _interception = await fixture.interceptAi(async (call) => {
    if (call.source !== "agent-turn") throw new Error(`unexpected source: ${call.source}`);
    const messages = call.body.messages;
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    // Routing DERIVES from committed context, never from call counts: the
    // platform legitimately re-asks (the attempt-progress watchdog fails a
    // churn-hung attempt and the retry ladder re-dials), and a retried
    // request must be served the same script — a positional queue desyncs.
    // An assistant message only lands when a reply actually settled, so its
    // content marks exactly which scripts have delivered.
    const assistantDelivered = (marker: string) =>
      messages.some((m) => m.role === "assistant" && m.content.includes(marker));
    const script = (() => {
      if (lastUser?.content.includes("warm up")) return warmUpScript;
      if (lastUser?.content.includes("prime factorize")) {
        return assistantDelivered("factors.map(String)") ? sendFactorsScript : factorizeScript;
      }
      if (lastUser?.content.includes("now do")) {
        if (assistantDelivered("should never send")) return correctSatisfiesScript;
        wrongAttemptServes.count += 1;
        return wrongSatisfiesScript;
      }
      throw new Error(`no scripted reply matches: ${lastUser?.content.slice(0, 80)}`);
    })();
    return ["```ts", script, "```"].join("\n");
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
  // The wrong attempt was really served, and — since the final message that
  // only the corrective attempt sends arrived — really rejected by the gate.
  // (If run()'s inference ever degraded to `any`, the wrong satisfies would
  // pass, that script would run, and "Result is 101 × 103" would never
  // appear — the wait above fails first.)
  if (wrongAttemptServes.count < 1) {
    throw new Error("the gate-rejected attempt was never served");
  }
});
