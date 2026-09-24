// scripts/fresh-preview-repro.ts — THE MINIMAL REPRO of a brand-new Worker Preview whose Durable
// Objects are not reachable yet (preview-readiness.ts has the history). No iterate code: a parent
// Worker `fresh-preview-repro` on the preview account (deployed here, idempotently; nothing else
// uses it) with one SQLite Durable Object class (fresh-preview-repro/worker.ts). Each run creates
// one brand-new preview of it and calls it at once and every 250 ms for `--seconds`, ten calls at a
// time, each on a Durable Object that never existed; then deploys the same preview again in place
// and calls it the same way; deletes it; and calls the parent the same way (the control). What it
// prints is what to send Cloudflare: per phase, the failed calls per 5 s since the phase began, when
// the first and last were, and samples with the `internal error; reference` ids workerd hands out.
//
//   doppler run --project os --config preview -- pnpm exec tsx scripts/fresh-preview-repro.ts --runs 3 --seconds 90
//
// 2026-09-24, from a laptop and from a Depot runner in IAD: 8 of 12 brand-new previews answered
// 97–519 of their first calls `internal error; reference = …`, the last of them 4–24 s after
// `wrangler preview` returned. 10 in-place redeploys answered none (their few failures were
// "Durable Object reset because its code was updated.", the expected kind); the parent answered 1
// in ~30,000 calls.
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { PREVIEW_PARENT } from "./preview-config.ts";
import { preparePreviewWrangler } from "./preview.ts";

const WORKER_NAME = "fresh-preview-repro";
const BINDING = { name: "PINGER", class_name: "Pinger" };

const { runs, seconds } = parseArgs(process.argv.slice(2));
const dir = mkdtempSync(path.join(tmpdir(), `${WORKER_NAME}-`));
copyFileSync(
  path.join(import.meta.dirname, "fresh-preview-repro", "worker.ts"),
  path.join(dir, "worker.ts"),
);
writeFileSync(
  path.join(dir, "wrangler.json"),
  JSON.stringify({
    name: WORKER_NAME,
    account_id: PREVIEW_PARENT.cloudflareAccountId,
    main: "worker.ts",
    compatibility_date: "2026-09-01",
    workers_dev: true,
    preview_urls: true,
    durable_objects: { bindings: [BINDING] },
    migrations: [{ tag: "v1", new_sqlite_classes: [BINDING.class_name] }],
    previews: { durable_objects: { bindings: [BINDING] } },
  }),
);
const wrangler = preparePreviewWrangler();
try {
  await wrangler.ready;
  // The parent, idempotently: `wrangler preview` branches off it and refuses a class it lacks.
  await wranglerRun(["deploy", "-c", "wrangler.json"]);
  for (let run = 1; run <= runs; run++) {
    // Each run: a brand-new preview (the failing case), the same preview deployed again in place
    // (the case that never failed in CI: 0 of 54 redeploys), and the parent itself (the control).
    const name = `repro-${Date.now().toString(36)}`;
    const preview = ["preview", "--name", name, "-c", "wrangler.json", "--json"];
    try {
      const url = lastJson(await wranglerRun(preview)).preview?.urls?.[0];
      if (!url) throw new Error("wrangler preview printed no URL");
      console.log(
        JSON.stringify({ run, name, phase: "new", ...(await callRepeatedly(url, seconds)) }),
      );
      await wranglerRun(preview);
      console.log(
        JSON.stringify({ run, name, phase: "redeployed", ...(await callRepeatedly(url, seconds)) }),
      );
    } finally {
      await wranglerRun(["preview", "delete", "--name", name, "-c", "wrangler.json", "-y"]);
    }
    const parentUrl = `https://${WORKER_NAME}.${new URL(PREVIEW_PARENT.baseUrl).host.split(".").slice(1).join(".")}`;
    console.log(
      JSON.stringify({ run, phase: "parent", ...(await callRepeatedly(parentUrl, seconds)) }),
    );
  }
} finally {
  wrangler.cleanup();
  rmSync(dir, { recursive: true, force: true });
}

/** Ten calls at once every 250 ms for `seconds`, each timed from now (the moment `wrangler preview`
 *  returned): every answer that was not `{ ok: true }`, and when the first and last of them were. */
async function callRepeatedly(url: string, seconds: number) {
  const start = Date.now();
  const failures: { atMs: number; status: number; answer: string }[] = [];
  let calls = 0;
  const pending: Promise<void>[] = [];
  while (Date.now() - start < seconds * 1000) {
    for (let i = 0; i < 10; i++) {
      calls++;
      const atMs = Date.now() - start;
      pending.push(
        fetch(url, { signal: AbortSignal.timeout(15_000) }).then(
          async (response) => {
            const answer = await response.text();
            if (!(response.ok && answer.includes('"ok":true')))
              failures.push({ atMs, status: response.status, answer: answer.slice(0, 200) });
          },
          (error: unknown) =>
            void failures.push({
              atMs,
              status: 0,
              answer: error instanceof Error ? error.message : String(error),
            }),
        ),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  await Promise.all(pending);
  failures.sort((a, b) => a.atMs - b.atMs);
  // Grouped by what answered: the preview URL not routed yet (404), workerd's opaque error from the
  // Durable Object call, anything else.
  const kinds = Object.groupBy(failures, (failure) =>
    failure.status === 404
      ? "notRoutedYet"
      : /internal error; reference = /.test(failure.answer)
        ? "internalError"
        : "other",
  );
  // failed calls per 5 s since the preview was created: how the failure rate decays (40 calls a second)
  const perFiveSeconds = Array.from(
    { length: Math.ceil(seconds / 5) },
    (_, bucket) => failures.filter((failure) => Math.floor(failure.atMs / 5000) === bucket).length,
  );
  return {
    calls,
    failed: failures.length,
    lastFailureMs: failures.at(-1)?.atMs,
    perFiveSeconds: perFiveSeconds.join(" "),
    ...Object.fromEntries(
      Object.entries(kinds).map(([kind, rows]) => [
        kind,
        {
          count: rows!.length,
          firstMs: rows![0]!.atMs,
          lastMs: rows!.at(-1)!.atMs,
          samples: rows!.slice(0, 3).map((row) => `${row.status} ${row.answer.slice(0, 120)}`),
        },
      ]),
    ),
  };
}

function wranglerRun(args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(wrangler.command, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
    child.once("error", reject);
    child.once("close", (status) =>
      status === 0
        ? resolve(output)
        : reject(new Error(`wrangler ${args[0]} exited ${status}:\n${output}`)),
    );
  });
}

/** `wrangler --json` logs prose ahead of the JSON object; the payload comes last. */
function lastJson(raw: string): { preview?: { urls?: string[] } } {
  const start = raw.lastIndexOf("\n{");
  return JSON.parse(raw.slice(start >= 0 ? start + 1 : raw.indexOf("{")));
}

function parseArgs(argv: string[]) {
  let runs = 1;
  let seconds = 30;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--runs") runs = Number(argv[++i]);
    else if (argv[i] === "--seconds") seconds = Number(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  return { runs, seconds };
}
