// Run WITHOUT a project context from apps/os:
//   pnpm cli itx run --file ../../.agents/skills/recreate-production/scripts/verify-slack-connection.itx.js \
//     --vars '{"projectId":"prj_...","connection":"workspace","expectedTeamId":"T..."}'
//
// Read-only. This proves that the normal Slack OAuth completion installed a
// usable project token and the deployment-wide webhook directory points at the
// same project/connection. It deliberately does not accept or repair tokens.

const projectId = String(vars.projectId ?? "").trim();
const connection = String(vars.connection ?? "").trim();
const expectedTeamId = String(vars.expectedTeamId ?? "").trim();
if (!projectId) throw new Error("vars.projectId is required");
if (!connection) throw new Error("vars.connection is required");
if (!expectedTeamId) throw new Error("vars.expectedTeamId is required");

const project = itx.projects.get(projectId);
const status = await project.integrations.getConnection({ provider: "slack", connection });
let auth;
try {
  auth = await project.integrations.slack.get(connection).auth.test();
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(
    `Slack auth.test failed for ${connection}: ${detail}. Complete Connect Slack OAuth before recreating the association.`,
  );
}

if (!status.connected) throw new Error(`Slack connection ${connection} is not connected`);
if (status.externalId !== expectedTeamId) {
  throw new Error(
    `Slack connection external id mismatch: expected ${expectedTeamId}, got ${String(status.externalId)}`,
  );
}
if (auth?.ok !== true) {
  throw new Error(`Slack auth.test failed: ${String(auth?.error ?? "unknown_error")}`);
}
if (auth.team_id !== expectedTeamId) {
  throw new Error(
    `Slack token team mismatch: expected ${expectedTeamId}, got ${String(auth.team_id)}`,
  );
}

const claimedType = "events.iterate.com/integration/connection-claimed";
const unclaimedType = "events.iterate.com/integration/connection-unclaimed";
const stream = itx.streams.get("/integrations/_directory");
let afterOffset = 0;
let claim = null;
let claimOffset = null;
for (;;) {
  const events = await stream.getEvents({
    afterOffset,
    eventTypes: [claimedType, unclaimedType],
    limit: 500,
  });
  for (const event of events) {
    afterOffset = event.offset;
    const payload = event.payload;
    if (payload?.slug !== "slack" || payload?.externalId !== expectedTeamId) continue;
    if (event.type === claimedType) {
      if (claim === null || claim.projectId === payload.projectId) {
        claim = { connection: payload.connection, projectId: payload.projectId };
        claimOffset = event.offset;
      }
    } else if (claim?.projectId === payload.projectId && claim?.connection === payload.connection) {
      claim = null;
      claimOffset = event.offset;
    }
  }
  if (events.length < 500) break;
}

if (claim?.projectId !== projectId || claim?.connection !== connection) {
  throw new Error(
    `Slack directory mismatch: expected ${projectId}/${connection}, got ${JSON.stringify(claim)}`,
  );
}

return {
  ok: true,
  projectId,
  connection,
  teamId: expectedTeamId,
  botUserId: auth.user_id ?? null,
  directoryClaimOffset: claimOffset,
};
