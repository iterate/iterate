const project = await itx.projects.get(vars.slug);
const identity = await project.identity();
const agents = await project.agents.list();
const streams = await project.streams.list();

const agentReports = [];
for (const listedAgent of agents) {
  const agent = project.agents.get(listedAgent.path);
  const snapshot = await agent.processor.snapshot();
  const events = await agent.stream.getEvents({ limit: 500 });
  agentReports.push({
    path: listedAgent.path,
    snapshotOffset: snapshot.offset,
    tokenUsage: snapshot.state.tokenUsage,
    llmUsageEvents: events
      .filter((event) => event.type === "events.iterate.com/agent/token-usage-reported")
      .map((event) => ({ offset: event.offset, ...event.payload })),
    userMessages: events
      .filter(
        (event) =>
          event.type === "events.iterate.com/agents/context-added" && event.payload.role === "user",
      )
      .map((event) => ({ offset: event.offset, message: event.payload.content })),
    messages: events
      .filter((event) => event.type === "events.iterate.com/agents/web-message-sent")
      .map((event) => ({ offset: event.offset, message: event.payload.message })),
    scriptRuns: events
      .filter((event) => event.type === "events.iterate.com/capability-host/script-run-requested")
      .map((event) => ({
        offset: event.offset,
        executionId: event.payload.executionId,
        chars: event.payload.code.length,
        code: event.payload.code,
      })),
    scriptSettlements: events
      .filter((event) => event.type === "events.iterate.com/capability-host/script-run-settled")
      .map((event) => ({ offset: event.offset, ...event.payload })),
  });
}

return { identity, agents: agentReports, streams };
