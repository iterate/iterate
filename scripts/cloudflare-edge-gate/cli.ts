import { envs } from "../../envs.ts";
import { resolveEnvContext } from "../lib/env-context.ts";
import { reconcileEdgeGate, resolveEdgeGateTarget, verifyEdgeGateTraffic } from "./reconcile.ts";

interface Options {
  env: string;
}

export async function plan(options: Options) {
  return run("plan", options);
}

export async function apply(options: Options) {
  return run("apply", options);
}

export async function verify(options: Options) {
  const { target, client } = await resolve(options);
  const drift = await reconcileEdgeGate("plan", target, client);
  if (drift.length > 0) throw new Error(`Edge gate has drift: ${JSON.stringify(drift)}`);
  await verifyEdgeGateTraffic(target);
  return { environment: target.envName, drift: [], smoke: "passed" };
}

async function run(mode: "plan" | "apply", options: Options) {
  const { target, client } = await resolve(options);
  return { environment: target.envName, changes: await reconcileEdgeGate(mode, target, client) };
}

async function resolve(options: Options) {
  const context = await resolveEnvContext({ envs, dopplerProject: "os", env: options.env });
  return {
    target: resolveEdgeGateTarget(context.name, context.env),
    client: { cfV4: context.cfV4 },
  };
}
