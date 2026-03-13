import { randomUUID } from "node:crypto";
import { DockerDeployment } from "@iterate-com/shared/jonasland/deployment/docker-deployment.ts";

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const dockerImage = process.env.JONASLAND_SANDBOX_IMAGE ?? process.env.E2E_DOCKER_IMAGE_REF ?? "";
  if (!dockerImage) throw new Error("set JONASLAND_SANDBOX_IMAGE or E2E_DOCKER_IMAGE_REF");

  await using deployment = await DockerDeployment.create({
    dockerImage,
    slug: `tmp-debug-${randomUUID().slice(0, 8)}`,
  });

  console.log(`[debug] baseUrl=${deployment.baseUrl}`);

  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    try {
      const caddy = await fetch(`${deployment.baseUrl}/__iterate/caddy-health`);
      console.log(`[debug] caddy-health status=${String(caddy.status)}`);
    } catch (error) {
      console.log(`[debug] caddy-health error=${String(error)}`);
    }

    try {
      const procs = await deployment.pidnap.processes.list();
      console.log(`[debug] procs=${procs.map((proc) => `${proc.name}:${proc.state}`).join(",")}`);
      for (const name of ["registry", "events"] as const) {
        const proc = await deployment.pidnap.processes.get({ target: name }).catch(() => null);
        if (proc) {
          console.log(
            `[debug] proc=${name} state=${proc.state} restarts=${String(proc.restarts)} command=${proc.definition.command}`,
          );
        }
      }
    } catch (error) {
      console.log(`[debug] pidnap list error=${String(error)}`);
    }

    for (const host of ["registry.iterate.localhost", "events.iterate.localhost"]) {
      try {
        const res = await deployment.fetch(host, "/api/__iterate/health");
        console.log(`[debug] ${host} status=${String(res.status)}`);
      } catch (error) {
        console.log(`[debug] ${host} error=${String(error)}`);
      }
    }

    await sleep(2_000);
  }

  const processLogs = await deployment.exec([
    "sh",
    "-lc",
    [
      'for f in /var/log/pidnap/*.log; do echo "===== $f ====="; tail -n 80 "$f"; done',
      'echo "===== process logs ====="',
      'for f in /home/iterate/src/github.com/iterate/iterate/logs/process/*.log; do echo "===== $f ====="; tail -n 100 "$f"; done 2>/dev/null || true',
    ].join("; "),
  ]);
  console.log("[debug] pidnap log tail:");
  console.log(processLogs.output);

  const registryWait = await deployment.pidnap.processes.waitForRunning({
    processSlug: "registry",
    timeoutMs: 5_000,
    includeLogs: true,
    logTailLines: 300,
  });
  console.log("[debug] waitForRunning(registry):");
  console.log(JSON.stringify(registryWait, null, 2));

  const eventsWait = await deployment.pidnap.processes.waitForRunning({
    processSlug: "events",
    timeoutMs: 5_000,
    includeLogs: true,
    logTailLines: 300,
  });
  console.log("[debug] waitForRunning(events):");
  console.log(JSON.stringify(eventsWait, null, 2));
}

void main();
