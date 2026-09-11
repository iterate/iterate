import fs from "node:fs";
import process from "node:process";
import { connectItxReady } from "../packages/iterate/src/node.ts";

const rpcTimeoutMs = 8_000;
const runTimeoutMs = 60_000;

type Row = { index: number; startedAtMs: number; endedAtMs: number; result: unknown };

function within<T>(label: string, operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    }),
  ]).finally(() => timer && clearTimeout(timer));
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function main() {
  const marker = crypto.randomUUID();
  const out = process.env.OUT ?? `/tmp/capability-provider-pager-lifecycle-${marker}.json`;
  const projectId = process.env.PROJECT_ID?.trim();
  const calls = Number(process.env.CALLS ?? "12");

  const startedAtMs = Date.now();
  const clientPath = `/clients/lifecycle-probe-${marker}`;
  const rows: Row[] = [];
  let providerInvocations = 0;
  let failure: string | undefined;
  let providerOwner: Disposable | undefined;
  let providerProjectOwner: Disposable | undefined;
  let callerOwner: Disposable | undefined;
  const artifact = () => ({
    kind: "preview-capability-lifecycle-probe",
    marker,
    projectId: projectId ?? null,
    clientPath,
    callsRequested: calls,
    providerInvocations,
    startedAtMs,
    endedAtMs: Date.now(),
    rows,
    ...(failure === undefined ? {} : { failure }),
    cleanup: "disposed provider project then caller and provider sessions",
  });

  try {
    if (!Number.isSafeInteger(calls) || calls < 1 || calls > 100)
      throw new Error("CALLS must be 1..100");
    const project = required("PROJECT_ID");
    const baseUrl = required("APP_CONFIG_BASE_URL");
    const secret = required("APP_CONFIG_ADMIN_API_SECRET");
    const auth = { type: "admin-secret" as const, secret };
    const provider = await within("provider connect", connectItxReady({ auth, baseUrl }), rpcTimeoutMs);
    providerOwner = provider;
    const caller = await within(
      "caller connect",
      connectItxReady({ auth, baseUrl, projectId: project }),
      rpcTimeoutMs,
    );
    callerOwner = caller;
    const providerProject = await within(
      "provider capability mount",
      provider.projects.connect(project, {
        path: clientPath,
        description:
          "temporary preview capability lifecycle probe; dispose after sequential health calls",
        capabilities: {
          health() {
            providerInvocations += 1;
            return { marker, providerInvocations, servedAtMs: Date.now() };
          },
        },
      }),
      rpcTimeoutMs,
    );
    providerProjectOwner = providerProject;
    const host = await within("capability host", caller.clients.get(clientPath), rpcTimeoutMs);
    for (let index = 0; index < calls; index++) {
      const remainingMs = startedAtMs + runTimeoutMs - Date.now();
      if (remainingMs <= 0) throw new Error(`run exceeded ${runTimeoutMs}ms`);
      const callStartedAtMs = Date.now();
      const result = await within(
        "health",
        host.invokeCapability({ args: [], path: ["health"] }),
        Math.min(rpcTimeoutMs, remainingMs),
      );
      rows.push({ index, startedAtMs: callStartedAtMs, endedAtMs: Date.now(), result });
    }
    // The contract requires idle after each settled call. This separate turn lets
    // the final Page run before teardown; it is not a lifetime allowance.
    await within("idle turn", new Promise((resolve) => setTimeout(resolve, 2_000)), rpcTimeoutMs);
  } catch (error) {
    failure = errorMessage(error);
    throw error;
  } finally {
    for (const resource of [providerProjectOwner, callerOwner, providerOwner]) {
      try {
        resource?.[Symbol.dispose]();
      } catch (error) {
        failure ??= `cleanup: ${errorMessage(error)}`;
      }
    }
    fs.writeFileSync(out, JSON.stringify(artifact(), null, 2));
    console.log(JSON.stringify(artifact(), null, 2));
  }
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
