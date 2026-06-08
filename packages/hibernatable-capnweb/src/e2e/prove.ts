import assert from "node:assert/strict";
import { RpcTarget } from "capnweb";
import { HibernatableCapnwebClient } from "../index.ts";
import type {
  PeerRecordArgs,
  PeerRecordResult,
  ProofHostApi,
  ProofPeerApi,
  ProofStatus,
} from "./proof-protocol.ts";

const baseHttpUrl = (process.env.HIBERNATABLE_CAPNWEB_PROOF_BASE_URL ?? process.argv[2])?.replace(
  /\/+$/,
  "",
);

if (!baseHttpUrl) {
  throw new Error(
    "Set HIBERNATABLE_CAPNWEB_PROOF_BASE_URL or pass the proof Worker URL as argv[2]",
  );
}

const baseWsUrl = baseHttpUrl.replace(/^http/i, "ws");
const hibernateWaitMs = Number(process.env.HIBERNATABLE_CAPNWEB_HIBERNATE_WAIT_MS ?? 12_000);
const heartbeatMs = Number(process.env.HIBERNATABLE_CAPNWEB_HEARTBEAT_MS ?? 250);
const requireHibernation = process.env.HIBERNATABLE_CAPNWEB_REQUIRE_HIBERNATION !== "false";

class NodePeerTarget extends RpcTarget implements ProofPeerApi {
  readonly received: PeerRecordResult[] = [];

  record(args: PeerRecordArgs): PeerRecordResult {
    const result = {
      runtime: "node",
      message: args.message,
      callerInstanceId: args.callerInstanceId,
      receivedCount: this.received.length + 1,
    };
    this.received.push(result);
    return result;
  }
}

const nodePeer = new NodePeerTarget();
const nodeId = `node-${crypto.randomUUID()}`;
const nodeClient = new HibernatableCapnwebClient<ProofHostApi, ProofPeerApi>(baseWsUrl, {
  id: nodeId,
  main: () => nodePeer,
  meta: { runtime: "node" },
  idleMs: 250,
  heartbeatMs,
});

const proof: Record<string, unknown> = {};

try {
  nodeClient.start();

  const connected = await waitForConnection(nodeId);
  assert.equal(
    connected.meta && typeof connected.meta === "object" && "runtime" in connected.meta
      ? connected.meta.runtime
      : undefined,
    "node",
  );
  proof.nodeControlListed = connected;

  if (heartbeatMs > 0) {
    const statusBeforePing = await status();
    await sleep(Math.max(600, heartbeatMs * 2));
    const statusAfterPing = await status();
    const nodeAfterPing = requiredConnection(statusAfterPing, nodeId);
    assert.equal(statusAfterPing.webSocketMessageCount, statusBeforePing.webSocketMessageCount);
    assert.ok(
      nodeAfterPing.autoResponseTimestamp,
      "expected edge auto-response timestamp after heartbeat",
    );
    proof.heartbeatAutoResponse = {
      messageCountBefore: statusBeforePing.webSocketMessageCount,
      messageCountAfter: statusAfterPing.webSocketMessageCount,
      autoResponseTimestamp: nodeAfterPing.autoResponseTimestamp,
    };
  } else {
    proof.heartbeatAutoResponse = "skipped; heartbeat disabled for production hibernation timing";
  }

  const host = await nodeClient.connect();
  const echo = await host.echo({ message: "node -> host" });
  assert.equal(echo.message, "node -> host");
  proof.nodeToHostRpc = echo;

  const beforeHibernate = await waitForConnectionLive(nodeId, false);
  await sleep(hibernateWaitMs);
  const afterHibernate = await status();
  const observedHibernation =
    afterHibernate.instanceId !== beforeHibernate.instanceId &&
    afterHibernate.constructorCount > beforeHibernate.constructorCount;
  if (requireHibernation) assert.ok(observedHibernation, "expected DO instance eviction");
  assert.equal(requiredConnection(afterHibernate, nodeId).live, false);
  proof.hibernateWake = {
    observedHibernation,
    waitMs: hibernateWaitMs,
    before: pickStatus(beforeHibernate),
    after: pickStatus(afterHibernate),
  };

  const hostCall = await fetchJson<{
    before: ProofStatus;
    result: PeerRecordResult;
    after: ProofStatus;
  }>(
    `/__proof/call-peer?id=${encodeURIComponent(nodeId)}&message=${encodeURIComponent("host -> node after wake")}`,
  );
  assert.equal(hostCall.before.instanceId, afterHibernate.instanceId);
  assert.equal(hostCall.result.runtime, "node");
  assert.equal(hostCall.result.message, "host -> node after wake");
  assert.equal(hostCall.result.callerInstanceId, afterHibernate.instanceId);
  assert.equal(nodePeer.received.length, 1);
  assert.equal(requiredConnection(hostCall.before, nodeId).live, false);
  assert.equal(requiredConnection(hostCall.after, nodeId).live, true);
  proof.hostToNodeAfterWake = hostCall;

  await sleep(500);
  const afterIdle = await status();
  assert.equal(requiredConnection(afterIdle, nodeId).live, false);
  proof.rpcIdleTeardown = pickStatus(afterIdle);

  const statelessWorker = await fetchJson<{
    id: string;
    echo: { message: string; instanceId: string };
    callback: PeerRecordResult;
  }>("/stateless-worker-proof");
  assert.equal(statelessWorker.echo.message, "stateless-worker -> host");
  assert.equal(statelessWorker.callback.runtime, "stateless-worker");
  assert.equal(statelessWorker.callback.message, "host -> stateless-worker");
  proof.statelessWorkerClient = statelessWorker;

  console.log(JSON.stringify({ ok: true, baseHttpUrl, nodeId, proof }, null, 2));
} finally {
  nodeClient.stop();
}

process.exit(0);

async function waitForConnection(id: string) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await status();
    const connection = current.connections.find((candidate) => candidate.id === id);
    if (connection) return connection;
    await sleep(50);
  }
  throw new Error(`timed out waiting for connection ${id}`);
}

async function waitForConnectionLive(id: string, live: boolean) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await status();
    const connection = current.connections.find((candidate) => candidate.id === id);
    if (connection?.live === live) return current;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${id} live=${live}`);
}

async function status() {
  return await fetchJson<ProofStatus>("/__proof/status");
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(`${baseHttpUrl}${path}`);
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as T;
}

function requiredConnection(status: ProofStatus, id: string) {
  const connection = status.connections.find((candidate) => candidate.id === id);
  assert.ok(connection, `expected ${id} in ${JSON.stringify(status.connections)}`);
  return connection;
}

function pickStatus(value: ProofStatus) {
  return {
    instanceId: value.instanceId,
    constructorCount: value.constructorCount,
    webSocketMessageCount: value.webSocketMessageCount,
    connections: value.connections,
  };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
