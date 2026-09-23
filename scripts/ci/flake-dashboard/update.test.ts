import { createVerify, generateKeyPairSync } from "node:crypto";
import { expect, test, vi } from "vitest";
import {
  artifactsToFold,
  iterateAppIssuesToken,
  rememberPass,
  workflowsToList,
  type DepotArtifact,
  type DepotWorkflow,
  type WriterState,
} from "./update.ts";

test("the same run listed on two passes more than 3 days apart folds once", () => {
  const workflow = finished("w1");
  const records = artifact("a1", "w1");
  let writer: Pick<WriterState, "workflows"> = { workflows: {} };

  const first = pass(writer, [workflow], [records], day(0));
  expect(first).toMatchObject({ folded: [records] });
  writer = { workflows: first.workflows };

  // Depot still lists the workflow four days later: nothing is folded again.
  const later = pass(writer, [workflow], [records], day(4));
  expect(later).toMatchObject({ listed: [], folded: [] });
  expect(later.workflows).toMatchObject({ w1: { folded: ["a1"], seenAt: day(4).toISOString() } });
});

test("a retried job's new attempt folds only its own artifact", () => {
  const first = pass({ workflows: {} }, [finished("w1")], [artifact("a1", "w1")], day(0));
  const retried = { ...finished("w1"), job_counts: { total: 2, finished: 2, failed: 0 } };

  const second = pass(
    { workflows: first.workflows },
    [retried],
    [artifact("a1", "w1"), artifact("a2", "w1")],
    day(0.1),
  );

  expect(second).toMatchObject({ listed: [retried], folded: [artifact("a2", "w1")] });
  expect(second.workflows).toMatchObject({ w1: { folded: ["a1", "a2"] } });
});

test("a workflow Depot stopped listing is forgotten 3 days after it was last listed", () => {
  const first = pass({ workflows: {} }, [finished("w1")], [artifact("a1", "w1")], day(0));

  expect(pass({ workflows: first.workflows }, [], [], day(2.9)).workflows).toHaveProperty("w1");
  expect(pass({ workflows: first.workflows }, [], [], day(3.1)).workflows).not.toHaveProperty("w1");
});

test("only flake-records artifacts of the listed workflows fold, in completion order", () => {
  const folded = artifactsToFold(
    { workflows: {} },
    [finished("w1")],
    [
      artifact("late", "w1", "2026-09-23T10:05:00Z"),
      { ...artifact("telemetry", "w1"), name: "unit-test-telemetry" },
      artifact("other workflow", "w2"),
      artifact("early", "w1", "2026-09-23T10:01:00Z"),
    ],
  );
  expect(folded.map((item) => item.artifact_id)).toEqual(["early", "late"]);
});

test("the iterate app's token is asked for issues: write on this repository only", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await using github = gitHubApp();

  const token = await iterateAppIssuesToken({
    appId: "2001598",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    owner: "iterate",
    repo: "iterate",
  });

  expect(token).toEqual({
    token: "ghs_narrowed",
    permissions: { issues: "write", metadata: "read" },
    repositories: ["iterate"],
  });
  const [installation, access] = github.fetch.mock.calls as unknown as [
    string,
    { method: string; headers: Record<string, string>; body?: string },
  ][];
  expect(installation![0]).toBe("https://api.github.com/repos/iterate/iterate/installation");
  expect(access![0]).toBe("https://api.github.com/app/installations/42/access_tokens");
  expect(JSON.parse(access![1].body!)).toEqual({
    repositories: ["iterate"],
    permissions: { issues: "write" },
  });
  // The app JWT: RS256 over header.payload, issued by the app, verifiable with its public key.
  const [header, payload, signature] = access![1].headers.authorization!.slice(7).split(".");
  expect(JSON.parse(Buffer.from(payload!, "base64url").toString())).toMatchObject({
    iss: "2001598",
  });
  expect(
    createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(publicKey, signature!, "base64url"),
  ).toBe(true);
});

/** One writer pass over a Depot listing: what it lists, what it folds, what it remembers. */
function pass(
  writer: Pick<WriterState, "workflows">,
  workflows: DepotWorkflow[],
  artifacts: DepotArtifact[],
  now: Date,
) {
  const listed = workflowsToList(writer, workflows);
  const folded = artifactsToFold(writer, listed, artifacts);
  return { listed, folded, workflows: rememberPass(writer, { workflows, folded, now }) };
}

function finished(workflowId: string): DepotWorkflow {
  return {
    workflow_id: workflowId,
    name: "Test",
    status: "finished",
    run_id: `run-${workflowId}`,
    head_sha: "abc123",
    created_at: "2026-09-23T10:00:00Z",
    job_counts: { total: 1, finished: 1, failed: 0 },
  };
}

function artifact(artifactId: string, workflowId: string, createdAt = "2026-09-23T10:02:00Z") {
  return {
    artifact_id: artifactId,
    run_id: `run-${workflowId}`,
    workflow_id: workflowId,
    name: "flake-records-unit",
    attempt: 1,
    size_bytes: 1000,
    created_at: createdAt,
  } satisfies DepotArtifact;
}

/** `days` (fractional ok) after a fixed epoch. */
function day(days: number) {
  return new Date(Date.UTC(2026, 8, 23) + days * 24 * 60 * 60 * 1000);
}

/** GitHub's App endpoints for the iterate app: its installation on this repo, and a narrowed token. */
function gitHubApp() {
  const fetch = vi.fn(async (url: string) =>
    url.endsWith("/installation")
      ? new Response(JSON.stringify({ id: 42 }))
      : new Response(
          JSON.stringify({
            token: "ghs_narrowed",
            permissions: { issues: "write", metadata: "read" },
            repositories: [{ name: "iterate" }],
          }),
          { status: 201 },
        ),
  );
  vi.stubGlobal("fetch", fetch);
  return {
    fetch,
    async [Symbol.asyncDispose]() {
      vi.unstubAllGlobals();
    },
  };
}
