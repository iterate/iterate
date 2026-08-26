import { connectAdminItx } from "./test-support/forged-session.ts";
import { test } from "./test-support/test.ts";

// Script reuse (itx.capabilityHost.previousScriptHelper) through the real
// chat UI, deterministically: the "model" is this spec's own interceptor.
// Turn 1 answers with a full Pollard's-rho factorization script; turn 2
// answers with a few-line reuse script pointing at turn 1's journaled run
// (previousScriptHelper({ ...results[0], parameterize })). Both scripts EXECUTE for real — the child run
// re-runs the original algorithm with the new number — and the spec opens
// each turn's codemode snippet in the feed to show the shortcut.
test("a repeat request reuses the previous turn's journaled script instead of re-deriving it", async ({
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

  // The "model": turn 1 derives, turn 2 reuses. Routing is just the count of
  // user messages in the turn's chat projection.
  using _interception = await project.ai.intercept(async (call) => {
    if (call.source !== "agent-turn") throw new Error(`unexpected source: ${call.source}`);
    const userTurns = call.body.messages.filter((message) => message.role === "user").length;
    const script = userTurns >= 2 ? REUSE_SCRIPT : FACTORIZE_SCRIPT;
    return ["```ts", script, "```"].join("\n");
  });

  await page.goto(`/projects/${fixture.project.slug}/agents/streams${agentPath}`);
  const composer = page.getByPlaceholder("Message this agent");
  const send = page.getByRole("button", { name: "Send message" });

  // Turn 1: the long way. The script really runs; the answer is computed.
  await composer.fill("prime factorize 52479543428582704627");
  await send.click();
  // timeout: the agent turn runs server-side with no loading UI for the spinnerWaiter to key off; preview turns take minutes (deployed workers, cold typecheck sidecar).
  await page.getByText("52479543428582704627 = 6203868971 × 8459163737").waitFor({
    timeout: 300_000,
  });

  // Turn 2: the reused way. The child run executes turn 1's algorithm with
  // the new number — the correct product proves real execution, not prose.
  await composer.fill("now do 66778601389380731119");
  await send.click();
  // timeout: same as above — no loading UI for the spinnerWaiter during the server-side turn.
  await page.getByText("66778601389380731119 = 7316102869 × 9127619251").waitFor({
    timeout: 300_000,
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
// sends the message from results[0].data, and turn 2 reuses the factorize row
// with `satisfies` assertions INSIDE the codemode script — the real typecheck
// gate, compiling against the real preamble, is the assertion engine. If the
// preamble types or the previousScriptHelper inference chain degrade, the
// gate rejects the script and this spec goes red.
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

  // Turns are strictly sequential, so a call counter is honest routing:
  // 1 = turn 1 round 1 (factorize, RETURN the factors),
  // 2 = turn 1 round 2 (send the message from results[0].data),
  // 3 = turn 2 (typed reuse).
  let modelCalls = 0;
  using _interception = await project.ai.intercept(async (call) => {
    if (call.source !== "agent-turn") throw new Error(`unexpected source: ${call.source}`);
    modelCalls += 1;
    const script = [RETURNING_SCRIPT, SEND_RESULT_SCRIPT, TYPED_REUSE_SCRIPT][modelCalls - 1];
    if (!script) throw new Error(`unexpected model call #${modelCalls}`);
    return ["```ts", script, "```"].join("\n");
  });

  await page.goto(`/projects/${fixture.project.slug}/agents/streams${agentPath}`);
  const composer = page.getByPlaceholder("Message this agent");
  const send = page.getByRole("button", { name: "Send message" });

  await composer.fill("prime factorize 8633");
  await send.click();
  // timeout: the agent turn runs server-side with no loading UI for the spinnerWaiter to key off; preview turns take minutes.
  await page.getByText("factors of 8633: 89 × 97").waitFor({ timeout: 300_000 });

  await composer.fill("now do 10403");
  await send.click();
  // timeout: same as above — no loading UI for the spinnerWaiter during the server-side turn.
  await page.getByText("Result is 101 × 103").waitFor({ timeout: 300_000 });
});

// Turn 1's scripted reply: a real, working factorization (Pollard's rho +
// deterministic Miller–Rabin). The message interpolates `n`, so a reused run
// reports whatever number it was actually given.
const FACTORIZE_SCRIPT = `async (itx) => {
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
}`;

// Turn 2's scripted reply: the whole point of the feature, in four lines.
const REUSE_SCRIPT = `async (itx) => {
  const helper = await itx.capabilityHost.previousScriptHelper({
    ...results[0],
    parameterize: { n: 52479543428582704627n },
  });
  await helper.run({ n: 66778601389380731119n });
}`;

// Typed-return flow, turn 1 round 1: RETURN the factors (JSON-serializable,
// so strings — bigints do not survive result serialization) instead of
// messaging. The returned value becomes a `data` row typed by its literal.
const RETURNING_SCRIPT = `async (itx) => {
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
}`;

// Turn 1 round 2: the settlement made the value results[0].data — send it.
const SEND_RESULT_SCRIPT = `async (itx) => {
  await itx.chat.sendMessage(\`factors of 8633: \${results[0].data.join(" × ")}\`);
}`;

// Turn 2: reuse the factorize row (results[1] — results[0] is round 2's done
// row) and assert the inferred types inside the script. The real typecheck
// gate compiles this against the real preamble: a degraded inference fails
// the run and the spec.
const TYPED_REUSE_SCRIPT = `async (itx) => {
  const helper = await itx.capabilityHost.previousScriptHelper({
    ...results[1],
    parameterize: { n: 8633n },
  });
  const result = await helper.run({ n: 10403n });
  result satisfies readonly string[];
  // @ts-expect-error - symmetry check: a string tuple is not a number array
  result satisfies readonly number[];
  // Anti-any tripwire the gate provably reports (tsgo does not flag unused
  // @ts-expect-error): \`true satisfies never\` errors iff result is any.
  type IsAny<T> = 0 extends 1 & T ? true : false;
  true satisfies (IsAny<typeof result> extends false ? true : never);
  await itx.chat.sendMessage(\`Result is \${result.join(" × ")}\`);
}`;
