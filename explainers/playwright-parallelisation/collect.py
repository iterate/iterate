"""Build an unsharded trace from Depot logs, metrics and downloaded test artifacts.

No network access here. Raw inputs stay outside the repo; only selected fields
are written. Missing markers are omitted, never assigned invented durations.
"""
import argparse
import hashlib
import json
import re
import statistics
import math
from datetime import datetime
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--metrics", type=Path, required=True)
p.add_argument("--resources", type=Path, required=True)
p.add_argument("--logs", type=Path, required=True)
p.add_argument("--artifacts", type=Path, required=True)
p.add_argument("--workers", type=int, required=True)
p.add_argument("--key", required=True)
p.add_argument("--label", required=True)
args = p.parse_args()
HERE = Path(__file__).resolve().parent
x = json.loads(args.metrics.read_text())
w = next(w for w in x["workflows"] if w["workflow"]["workflow_path"] == "cloudflare-previews.yml")
workflow = w["workflow"]
assert workflow.get("finished_at"), "Wait for cleanup before collecting"
t0 = datetime.fromisoformat(workflow["started_at"].replace("Z", "+00:00"))


def sec(t):
    return round((datetime.fromisoformat(t.replace("Z", "+00:00")) - t0).total_seconds(), 3)


lines = []
for line in args.logs.read_text().splitlines():
    if re.match(r"^2026-\d\d-\d\dT", line):
        stamp, text = line.split(" ", 1)
        text = text.replace("\\u001b", "\x1b")
        lines.append((sec(stamp), re.sub(r"\x1b\[[\d;]*m", "", text)))


def mark(text, after=-1):
    return next((t for t, line in lines if t > after and text in line), None)


nodes = []


def add(parent, label, start, end, kind, note, basis="Timestamped log boundaries", **extra):
    if start is None or end is None:
        return None
    assert end >= start - 0.01, (label, start, end)
    n = dict(id=f"n{len(nodes)}", label=label, start=round(start, 3), end=round(end, 3),
             kind=kind, note=note, basis=basis, children=[], **extra)
    nodes.append(n)
    if parent is not None:
        parent["children"].append(n)
    return n


root = add(None, args.label, 0, sec(workflow["finished_at"]), "job",
           f"One 16-core / 64-GB runner, {args.workers} maximum Playwright workers. Other app tests share this machine.", "Depot workflow timestamps")
j = w["jobs"][0]
job = add(root, "Preview / deploy + e2e", sec(j["job"]["started_at"]), sec(j["job"]["finished_at"]),
          "job", "One checkout/install; deployment, tests, reporting and cleanup reuse this machine.",
          "Depot job timestamps", attempt=j["attempts"][0]["attempt"]["attempt_id"])
checkout = mark("Syncing repository")
install = mark("##[group]Run pnpm install")
installed = mark("using pnpm v10.24.0")
add(job, "Runner startup / unlogged setup", job["start"], checkout, "other", "Runner assignment and startup before checkout.")
add(job, "Checkout + epoch check", checkout, install, "other", "Checkout exact PR head and validate deployment compatibility.")
add(job, "pnpm install", install, installed, "install", "Frozen, prefer-offline reconciliation against the baked workspace. Mutable image tag; exact digest unrecorded.")
erases = [(t, match) for t, line in lines if (match := re.search(r"\[preview\] erased (preview-\d+) data \(([\d.]+)s\)", line))]
slot = erases[0][1][1] if erases else "unknown"
if erases:
    end, match = erases[0]
    begin = end - float(match[2])
    add(job, "Resolve PR, lease + deploy plan", installed, begin, "other", "Resolve the PR head, lease and deployment plan.")
    add(job, "Clean old preview data", begin, end, "cleanup", "Pre-deploy resource cleanup, including the artifact repository deadline.", "End log minus reported cleanup duration")

reports = []
for f in (args.artifacts / "ci-telemetry" / "raw").rglob("*.json"):
    report = json.loads(f.read_text())
    if "context" in report and "run" in report:
        reports.append(report)
deployment = next((r["deployment"] for r in reports if r.get("deployment")), None)
deploy_end = None
if deployment and deployment.get("lanes"):
    lanes = deployment["lanes"]
    deploy_start = min(sec(d["finishedAt"]) - d["durationMs"] / 1000 for d in lanes)
    deploy_end = max(sec(d["finishedAt"]) for d in lanes)
    group = add(job, "Deploy selected apps concurrently", deploy_start, deploy_end, "deploy", "Includes fresh builds/deployments and proven reuse.", "Deployment telemetry")
    for d in lanes:
        finish = sec(d["finishedAt"])
        begin = finish - d["durationMs"] / 1000
        n = add(group, d["app"], begin, finish, "deploy", f"Deployment outcome: {d.get('status', 'recorded')}.", "Deployment telemetry")
        cursor = begin
        for key, name in [("configDurationMs", "Configure"), ("commandDurationMs", "Build + deploy command"), ("readinessDurationMs", "Verify deployed version"), ("reuseProofDurationMs", "Prove deployment reuse")]:
            length = d.get(key, 0) / 1000
            if length:
                add(n, name, cursor, cursor + length, "deploy", "Sequential orchestrator subphase.", "Telemetry durations positioned in code order")
                cursor += length

ready = mark("[preview:os] environment readiness start")
ready_end = mark("[preview:os] environment readiness finish")
test_start = mark("[preview] testable apps for head")
test_end = mark("[preview] tests finished:")
if test_end is None:
    test_end = mark("##[group]Run set -euo pipefail", ready_end or ready or installed or -1)
add(job, "Publish deployment + seed test login", deploy_end, test_start, "other", "Publish deployment identity and seed test logins.")
tests = add(job, "Run app suites + OS readiness", test_start, test_end, "test", "Other apps run during readiness; root Playwright and OS Vitest start after shared readiness.") or job
rd = add(tests, "Shared OS readiness", ready, ready_end, "readiness", "Smoke, rollout timer, TUI and browser check overlap.")
if rd:
    for name, label in [("rollout-settle", "Rollout settle timer"), ("smoke", "Agent smoke"), ("tui", "TUI quarantine check")]:
        add(rd, label, mark(f"lane start: {name}"), mark(f"lane finish: {name}"), "readiness", "Readiness subtask.")
    add(rd, "Chromium install/check", ready, ready_end, "browser", "Runs during readiness; exact command duration was not logged.", "Known from code; duration unrecorded", unknown=True)

suite_reports = [r for r in reports if r["context"]["framework"] in ["vitest", "playwright"]]
root_pw = next((r for r in suite_reports if r["context"].get("workspace") == "iterate-root"), None)
apps = [r for r in suite_reports if r is not root_pw]
os_vit = next((r for r in apps if r["context"].get("app") == "os" and r["context"]["framework"] == "vitest"), None)
app_retries = sum(t.get("retryCount", 0) for r in apps for t in r["tests"])
for r in apps:
    retry_count = sum(t.get("retryCount", 0) for t in r["tests"])
    group = add(tests, f'{r["context"]["app"]} · {r["context"]["framework"]}', sec(r["run"]["startedAt"]), sec(r["run"]["finishedAt"]), "test", f"{retry_count} test retries. Reporter interval; buffered stdout is not used as execution time.", "Test telemetry")
    if r is os_vit:
        for t in r["tests"]:
            for a in t.get("attempts", []):
                if a.get("startedAt") and a.get("durationMs"):
                    start = sec(a["startedAt"])
                    add(group, t["fullName"] + (f' · retry {a["attemptIndex"]}' if a.get("attemptIndex") else ""), start, start + a["durationMs"] / 1000, "test", f"Attempt {a.get('attemptIndex', 0)}; {a['state']}.", "Vitest test attempt telemetry", test=True)

pw_start = mark("[preview:os] lane start: playwright")
pw_end = mark("[preview:os] lane finish: playwright")
pw_group = add(tests, f"Playwright command · {args.workers} workers", pw_start, pw_end, "test", "Includes CLI startup, global setup, Expo, worker pool and reports.") or tests
pool_start = next((t for t, line in lines if pw_start is not None and t >= pw_start and re.search(r"Running \d+ tests using \d+ workers", line)), None)
add(pw_group, "Global setup + mobile web server", pw_start, pool_start, "other", "Start Playwright, Expo and global auth setup before the worker pool.")
pool = add(pw_group, "Worker pool + reporting", pool_start, pw_end, "test", "Each bar is one actual attempt. Worker IDs in the inspector show process reuse and retries.") or pw_group
active_intervals = []
first_starts = []
green = skipped = body_failures = retries = sentinel_failures = 0
if root_pw:
    for t in root_pw["tests"]:
        retries += t.get("retryCount", 0)
        if t["state"] == "skipped":
            skipped += 1
            continue
        sentinel_test = t.get("expectedState") == "failed" and " › flake-sentinel.spec.ts › " in t["fullName"]
        if sentinel_test and any("monthly flake sentinel" in e.get("message", "") for e in t.get("errors", [])):
            sentinel_failures += 1
        wrapper_pass = t.get("expectedState") == "failed" and any("Flaky test passed this run" in e.get("message", "") for e in t.get("errors", []))
        if t["state"] == "passed" or wrapper_pass:
            green += 1
        else:
            body_failures += 1
        for a in t.get("attempts", []):
            if not a.get("startedAt"):
                continue
            start = sec(a["startedAt"])
            finish = start + a["durationMs"] / 1000
            active_intervals.append((start, finish))
            if a.get("attemptIndex", 0) == 0:
                first_starts.append(start)
            sentinel_attempt = sentinel_test and "monthly flake sentinel" in a.get("error", {}).get("message", "")
            outcome = "deliberate monthly flake sentinel (expected)" if sentinel_attempt else "body passed; quarantine wrapper throws as expected" if "Flaky test passed this run" in a.get("error", {}).get("message", "") else a["state"]
            module = t["moduleId"].replace("/home/runner/work/iterate/iterate/", "")
            attempt_node = add(pool, t["fullName"] + (f' · retry {a["attemptIndex"]}' if a.get("attemptIndex") else ""), start, finish, "test", f"{module} · {outcome} · worker {a.get('workerIndex')} / slot {a.get('parallelIndex')} · attempt {a.get('attemptIndex', 0)}.", "Playwright per-attempt telemetry", test=True, failed=not sentinel_attempt and a["state"] not in ["passed", "skipped"] and "Flaky test passed this run" not in a.get("error", {}).get("message", ""))
            for phase in a.get("phases", []):
                if phase["name"] in ["Before Hooks", "After Hooks", "create project fixture", "create mobile fixture", "connect admin itx"] and phase.get("startedAt") and phase.get("durationMs", 0) >= 100:
                    phase_start = sec(phase["startedAt"])
                    phase_end = phase_start + phase["durationMs"] / 1000
                    if phase_start >= start - 0.002 and phase_end <= finish + 0.002:
                        add(attempt_node, phase["name"], phase_start, phase_end, "other", "Recorded fixture/setup phase inside this attempt. Only fixed phase names are published; dynamic URLs and raw errors stay in the CI artifact.", "Playwright step telemetry")
                    else:
                        attempt_node["note"] += f" {phase['name']} has a timestamp outside the reported attempt interval; omitted from nesting (end offset {phase_end - finish:+.3f}s)."

erase_start = mark("##[group]Run set -euo pipefail", test_end or ready_end or installed or -1)
upload = mark("##[group]Run doppler run --project _shared --config prd -- pnpm tsx scripts/ci/upload-test-telemetry")
add(job, "Publish test results", test_end, erase_start, "artifact", "Record test outcomes without a new runner or cross-job report merge.")
cleanup = add(job, "Post-test cleanup", erase_start, upload, "cleanup", "Cleanup remains on the same runner after tests, with the existing head/lease guards.")
if cleanup and len(erases) > 1:
    end, match = erases[-1]
    add(cleanup, "Erase slot resources", end - float(match[2]), end, "cleanup", "OS reset, D1/KV, artifact repositories and supporting-service cleanup.", "End log minus reported cleanup duration")
add(job, "Telemetry + artifact uploads", upload, job["end"], "artifact", "Upload complete test telemetry and reports.")

resources = json.loads(args.resources.read_text())
samples = [dict(time=sec(s["timestamp"]), **({"cpu": s["cpu_utilization"]} if "cpu_utilization" in s else {}), **({"memory": s["memory_utilization"]} if "memory_utilization" in s else {})) for s in resources["attempt"].get("samples", [])]
metrics = dict(result=j["job"]["conclusion"], playwright=root_pw["run"]["durationMs"] / 1000 if root_pw else None,
               vitest=os_vit["run"]["durationMs"] / 1000 if os_vit else None, browserRetries=retries,
               appRetries=app_retries, browserGreen=green, browserSkipped=skipped, browserBodyFailures=body_failures, browserSentinelFailures=sentinel_failures,
               readiness=ready_end - ready if ready is not None and ready_end is not None else None,
               erase=[float(m[2]) for _, m in erases])
browser_window = [sec(root_pw["run"]["startedAt"]), sec(root_pw["run"]["finishedAt"])] if root_pw else [pw_start or test_start or 0, pw_end or test_end or root["end"]]
subset = [s for s in samples if browser_window[0] <= s["time"] <= browser_window[1]]
cpu = [s["cpu"] for s in subset if "cpu" in s]
memory = [s["memory"] for s in subset if "memory" in s]
if cpu and memory:
    metrics.update(cpuMean=sum(cpu) / len(cpu), cpuPeak=max(cpu), memoryPeak=max(memory))
    resource_label = "During Playwright" if root_pw else "Available test-command window (report missing)"
    metrics["resourceSummary"] = f"{resource_label}: sampled mean CPU {sum(cpu) / len(cpu) * 100:.1f}% ({sum(cpu) / len(cpu) * 16:.1f} cores), peak {max(cpu) * 100:.1f}% ({max(cpu) * 16:.1f} cores); peak memory {max(memory) * 64:.1f} GB. {len(subset)} samples."
events = sorted([(s, 1) for s, e in active_intervals] + [(e, -1) for s, e in active_intervals])
active = peak = 0
for _, change in events:
    active += change
    peak = max(peak, active)
metrics["peakActiveAttempts"] = peak
metrics["firstStartSpread"] = max(first_starts) - min(first_starts) if first_starts else None
lengths = sorted(e - s for s, e in active_intervals)
if lengths:
    metrics.update(attemptDurationMedian=statistics.median(lengths), attemptDurationP95=lengths[math.ceil(len(lengths) * 0.95) - 1], attemptDurationMax=max(lengths), activeAttemptSeconds=sum(lengths))
if root_pw:
    mobile_setup = [phase["durationMs"] / 1000 for t in root_pw["tests"] for a in t.get("attempts", []) for phase in a.get("phases", []) if phase["name"] == "create mobile fixture"]
    metrics["mobileFixtureMedian"] = statistics.median(mobile_setup) if mobile_setup else None
if root_pw is None:
    for field in ["browserRetries", "browserGreen", "browserSkipped", "browserBodyFailures", "peakActiveAttempts"]:
        metrics[field] = None
if not apps:
    metrics["appRetries"] = None
catalogue = sorted(t["fullName"] for t in root_pw["tests"]) if root_pw else []
record = dict(root=root, total=root["end"], run=x["run"]["run_id"], workflow=workflow["workflow_id"], head=x["run"]["head_sha"],
              label=args.label, normal=True, workers=args.workers, slot=slot, startedAt=workflow["started_at"], metrics=metrics,
              installs=[dict(job="Preview / deploy + e2e", start=install, end=installed, order=0)] if installed else [],
              installWall=installed - install if installed else 0, installSum=installed - install if installed else 0,
              windows={"prepare": [0, ready_end or test_start or root["end"]], "tests": [test_start or 0, test_end or root["end"]], "finish": [erase_start or root["end"], root["end"]]},
              browserWindow=browser_window, samples=samples, catalogueCount=len(catalogue), catalogueHash=hashlib.sha256(json.dumps(catalogue).encode()).hexdigest(),
              imageTag="0p91s0lz49.registry.depot.dev/iterate-preview-ci:node24-pnpm10-worktree", bakedSourceHead=next((m[1] for _, line in lines if (m := re.search(r"HEAD is now at ([a-f0-9]+)", line))), None),
              context=f"{args.label} · run {x['run']['run_id']} · commit {x['run']['head_sha'][:9]} · {slot}. Same application code; fresh runner.",
              findings=f"{green} browser bodies passed, {skipped} skipped, {body_failures} body failures, {retries} browser retries, {app_retries} app retries. Peak simultaneous test attempts: {peak}. " + metrics.get("resourceSummary", ""))
if root_pw is None:
    record["findings"] = "Root Playwright report unavailable. The trace retains observed job/log intervals; browser outcomes and retry counts are unknown. " + metrics.get("resourceSummary", "")
for n in nodes:
    n["children"].sort(key=lambda c: c["start"])
    for child in n["children"]:
        assert child["start"] >= n["start"] - 0.2 and child["end"] <= n["end"] + 0.2, ("Span outside parent", n["label"], child["label"])
(HERE / "runs" / f"{args.key}.json").write_text(json.dumps(record, separators=(",", ":")) + "\n")
print(json.dumps({"key": args.key, "run": record["run"], "total": record["total"], "install": record["installWall"], **metrics}, indent=2))
