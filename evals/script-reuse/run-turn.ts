const project = await itx.projects.get(vars.slug).create({});
const agent = project.agents.get("/agents/probe");
if (vars.firstTurn) await agent.create();
const reply = await agent.ask({ message: vars.message, timeoutMs: 240_000 });

const settleDeadline = Date.now() + 240_000;
for (;;) {
  const snapshot = await agent.processor.snapshot();
  const state = snapshot.state;
  const settled =
    state.openRequest === null &&
    state.pendingLlmRequestTrigger === null &&
    state.activeScriptExecutions.length === 0;
  if (settled) break;
  if (Date.now() >= settleDeadline)
    throw new Error("Agent did not fully settle within 240 seconds");
  await new Promise((resolve) => setTimeout(resolve, 100));
}

return { slug: vars.slug, reply: reply.payload };
