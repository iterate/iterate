"""Sanitize a multi-runner measurement into the existing interactive trace format.

Input directory: metrics.json, <attempt-id>.log, and the extracted canonical
artifact in artifacts/. Raw logs, errors, URLs and credentials are never copied.
"""
import argparse
import hashlib
import json
import math
import re
import statistics
from datetime import datetime
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("directory", type=Path)
p.add_argument("--key", required=True)
p.add_argument("--label", required=True)
a = p.parse_args()
here = Path(__file__).resolve().parent
m = json.loads((a.directory / "metrics.json").read_text())
w = next(w for w in m["workflows"] if w["workflow"]["workflow_path"] in {"preview.yml", "cloudflare-previews.yml"})
wf = w["workflow"]
assert wf.get("finished_at"), "Wait for all jobs, including cleanup"
t0 = datetime.fromisoformat(wf["started_at"].replace("Z", "+00:00"))

def sec(t):
    return round((datetime.fromisoformat(t.replace("Z", "+00:00")) - t0).total_seconds(), 3)

nodes = []
def add(parent, label, start, end, kind, note, basis="Timestamped log boundaries", **extra):
    if start is None or end is None:
        return None
    assert end >= start, (label, start, end)
    n = dict(id=f"o{len(nodes)}", label=label, start=start, end=end, kind=kind, note=note,
             basis=basis, children=[], **extra)
    nodes.append(n)
    if parent is not None:
        parent["children"].append(n)
    return n

root = add(None, a.label, 0, sec(wf["finished_at"]), "job",
           "Prepare, app tests and six browser shards start together. Test runners prepare before waiting for readiness. Finalizer setup overlaps testing.", "Depot workflow timestamps", failed=wf["status"] != "finished")
job_nodes, logs, installs, erasings, shard_phases = {}, {}, [], [], {}
job_order = ["prepare", "apps"] + [f"playwright:matrix-{i}" for i in range(6)] + ["finish"]

def mark(lines, text, after=-1):
    return next((t for t, line in lines if t >= after and text in line), None)

for j in w["jobs"]:
    key = j["job"]["job_key"].split(":preview:", 1)[1]
    attempt = j["attempts"][-1]["attempt"]["attempt_id"]
    label = f"Playwright {int(key.rsplit('-', 1)[1]) + 1}/6" if key.startswith("playwright:") else {"prepare": "Prepare", "apps": "App tests", "finish": "Teardown + reporting"}[key]
    job = add(root, label, sec(j["job"]["started_at"]), sec(j["job"]["finished_at"]), "job",
              "Dedicated runner. Parent durations include their children.", "Depot job timestamps",
              attempt=attempt, order=job_order.index(key), failed=j["job"]["status"] != "finished")
    stats = j["attempts"][-1].get("stats", {})
    cores, memory_gb = (4, 16) if key == "finish" else (16, 64)
    if stats.get("cpu_sample_count") and stats.get("memory_sample_count"):
        job["note"] += f" Whole-job sampled peak: {stats['peak_cpu_utilization']*cores:.1f}/{cores} CPU cores, {stats['peak_memory_utilization']*memory_gb:.1f}/{memory_gb} GB RAM. Includes install and waiting, not just test time."
    job_nodes[key] = job
    lines = []
    for line in (a.directory / f"{attempt}.log").read_text().splitlines():
        if re.match(r"^\d{4}-\d\d-\d\dT", line):
            stamp, text = line.split(" ", 1)
            lines.append((sec(stamp), re.sub(r"\x1b\[[\d;]*m", "", text.replace("\\u001b", "\x1b"))))
    logs[key] = lines
    checkout = mark(lines, "Syncing repository")
    install = mark(lines, "##[group]Run pnpm install")
    installed = mark(lines, "using pnpm v10.24.0")
    waiting = next((t for t, line in lines if line.startswith("##[group]Run ") and "status.ts wait-for prepare preview-ready" in line), None)
    ready = next((t for t, line in lines if "[ci:status] reached ci/" in line and line.endswith("/preview-ready")), None)
    browser_start = mark(lines, "##[group]Run pnpm exec playwright install chromium")
    browser_end = mark(lines, "##[group]Run doppler run", browser_start) if browser_start else None
    setup = job
    if key.startswith("playwright:"):
        job["shard"] = int(key.rsplit("-", 1)[1]) + 1
        uploading = mark(lines, "With the provided path, there will be", ready)
        uploaded = mark(lines, f"Artifact preview-ci-playwright-{job['shard']} has been successfully uploaded!", uploading)
        assert all(t is not None for t in [waiting, ready, uploading, uploaded]), f"Missing phase boundary: {key}"
        setup = add(job, "Setup", job["start"], waiting, "other", "Runner startup, checkout, dependencies and Chromium. Expand to see the measured components.", "Job start to readiness-wait step start")
        testing = add(job, "Run Playwright", ready, uploading, "test", "Download the prepared deployment plan, validate it, run Playwright and write its reports. Expand for startup and individual test attempts.", "Readiness acknowledgement to first result-upload log")
        shard_phases[key] = testing
        upload_phase = add(job, "Upload results", uploading, job["end"], "artifact", "Upload the report artifact and finish the job. The cleanup barrier waits for this job to terminate.", "First upload log to job completion")
        add(upload_phase, "Upload artifact", uploading, uploaded, "artifact", "Report ZIP upload and finalization.")
        add(upload_phase, "Job teardown", uploaded, job["end"], "other", "Post-action cleanup and remaining job completion time.")
        download_start = mark(lines, "Downloading single artifact", ready)
        download_end = mark(lines, "Artifact download completed successfully.", download_start)
        add(testing, "Download deployment plan", download_start, download_end, "artifact", "Download the immutable plan published before the readiness milestone.")
    add(setup, "Runner startup / unlogged setup", job["start"], checkout, "other", "Runner startup before the first checkout log.")
    add(setup, "Checkout", checkout, install, "other", "Checkout the exact candidate into the baked workspace.")
    add(setup, "pnpm install", install, installed, "install", "Frozen, prefer-offline dependency reconciliation.")
    if installed is not None:
        installs.append(dict(job=label, start=install, end=installed, order=job_order.index(key)))
    add(setup, "Chromium install/check", browser_start, browser_end, "browser", "Reconcile browsers before waiting. End is the next step boundary.")
    add(job, "Wait for preview readiness", waiting, ready, "readiness", "Exact producer-attempt milestone, guarded by Depot producer liveness. Includes waiter startup and polling.")
    for t, line in lines:
        match = re.search(r"\[preview\] erased (preview-\d+) data \(([\d.]+)s\)", line)
        if match:
            duration = float(match[2])
            erasings.append((key, t, duration, match[1]))
            add(job, "Clean old preview data" if key == "prepare" else "Erase preview resources", round(t-duration, 3), t, "cleanup", "Measured erase command duration. Report processing may overlap.", "End log minus reported duration")

prep = logs["prepare"]
ready_start = mark(prep, "[preview:os] environment readiness start")
ready_end = mark(prep, "[preview:os] environment readiness finish")
readiness = add(job_nodes["prepare"], "Shared OS readiness", ready_start, ready_end, "readiness", "Smoke and rollout wait run together before publishing the deployment plan.")
if readiness:
    for key, label in [("rollout-settle", "Rollout timer"), ("smoke", "Agent smoke"), ("tui", "TUI check")]:
        start, end = mark(prep, f"lane start: {key}"), mark(prep, f"lane finish: {key}")
        if start is not None and end is not None:
            # TUI can finish just after the readiness marker; attach to the job.
            parent = readiness if start >= readiness["start"] and end <= readiness["end"] else job_nodes["prepare"]
            add(parent, label, start, end, "readiness", "Readiness component.")

finish_lines = logs["finish"]
wait_start = mark(finish_lines, "[ci:status] waiting for all consumers")
wait_end = next((t for t, line in finish_lines if f"[ci:status] {wf['workflow_path']}:" in line and
                 all(state not in line for state in [": running", ": queued", ": waiting"])), None)
add(job_nodes["finish"], "Wait for all test jobs + report uploads", wait_start, wait_end, "readiness", "All-settled barrier: failed consumers do not release cleanup while others are running.")
upload = mark(finish_lines, "##[group]Run doppler run --project _shared --config prd -- pnpm tsx scripts/ci/upload-test-telemetry")
add(job_nodes["finish"], "Collect and merge reports / cleanup in parallel", wait_end, upload, "artifact", "Enclosing parallel phase. Resource erase has its own measured span; do not add overlapping durations.")
add(job_nodes["finish"], "Telemetry + artifact uploads", upload, job_nodes["finish"]["end"], "artifact", "Normalize telemetry, upload reports and assert all consumer outcomes.")

reports = []
report_sources = []
for f in (a.directory / "artifacts" / "ci-telemetry" / "raw").rglob("*.json"):
    r = json.loads(f.read_text())
    if "context" in r and "run" in r:
        reports.append(r)
        report_sources.append((f, r))

deployment = next((r["deployment"] for r in reports if r.get("deployment")), None)
if deployment and deployment.get("lanes"):
    for d in deployment["lanes"]:
        end = sec(d["finishedAt"])
        add(job_nodes["prepare"], f"Deploy {d['app']}", round(end-d["durationMs"]/1000, 3), end, "deploy", f"Deployment outcome: {d.get('status', 'recorded')}", "Deployment telemetry")

root_reports = [r for r in reports if r["context"].get("workspace") == "iterate-root" and r["context"]["framework"] == "playwright"]
app_reports = [r for r in reports if r["context"]["framework"] in ["vitest", "playwright"] and r not in root_reports]
intervals, first_starts, catalogue = [], [], []
green = skipped = failures = retries = sentinel_failures = 0
for r in root_reports:
    start, end = sec(r["run"]["startedAt"]), sec(r["run"]["finishedAt"])
    # Reporter intervals must match exactly one runner's logged spec command.
    candidates = [key for key in job_nodes if key.startswith("playwright:") and
                  any(f"--shard={int(key.rsplit('-',1)[1])+1}/6" in line for _, line in logs[key]) and
                  job_nodes[key]["start"] <= start <= end <= job_nodes[key]["end"]]
    # Per-shard reporter files live under raw/playwright-N. Match via their source path below.
    sources = [path for path, report in report_sources if report is r]
    match = next((re.search(r"playwright-(\d+)", str(f)) for f in sources if re.search(r"playwright-(\d+)", str(f))), None)
    assert match, "Root reporter artifact must retain its shard directory"
    key = f"playwright:matrix-{int(match[1])-1}"
    assert key in candidates, (key, start, end)
    command = mark(logs[key], "> playwright test --config")
    suite = shard_phases[key]
    suite["failed"] = r["run"]["status"] != "passed"
    suite["note"] += f" The reporter interval is {r['run']['durationMs']/1000:.1f}s within this phase; the phase also includes plan download and command overhead."
    first_test = min(sec(attempt["startedAt"]) for test in r["tests"] for attempt in test.get("attempts", []) if attempt.get("startedAt") and attempt["state"] != "skipped")
    last_test = max(sec(attempt["startedAt"])+attempt["durationMs"]/1000 for test in r["tests"] for attempt in test.get("attempts", []) if attempt.get("startedAt") and attempt["state"] != "skipped")
    download_end = mark(logs[key], "Artifact download completed successfully.", suite["start"])
    add(suite, "Resolve preview and start CLI", download_end, command, "other", "Validate deployment identity and slot ownership; start the spec command.")
    add(suite, "Playwright startup / global setup", command, first_test, "other", "CLI invocation until the first test attempt starts, including global setup, the web server and worker startup. Reporter timing begins within this interval.", "CLI log to first reporter-recorded attempt")
    add(suite, "Write reports / command finish", round(last_test, 3), suite["end"], "artifact", "Final reporter output and command completion before the first upload log.", "Last attempt end to first upload log")
    for t in r["tests"]:
        catalogue.append(t["fullName"])
        retries += t.get("retryCount", 0)
        if t["state"] == "skipped":
            skipped += 1
            continue
        wrapper_pass = t.get("expectedState") == "failed" and any("Flaky test passed this run" in e.get("message", "") for e in t.get("errors", []))
        sentinel = t.get("expectedState") == "failed" and " › flake-sentinel.spec.ts › " in t["fullName"] and any("monthly flake sentinel" in e.get("message", "") for e in t.get("errors", []))
        sentinel_failures += int(sentinel)
        # The quarantine wrapper RETURNS on an unexpected body error. Playwright
        # calls that "passed" despite expectedState=failed: it is a RED result.
        passed = (t["state"] == "passed" and t.get("expectedState") != "failed") or wrapper_pass
        green += int(passed)
        failures += int(not passed)
        for attempt in t.get("attempts", []):
            if not attempt.get("startedAt"):
                continue
            begin = sec(attempt["startedAt"])
            end = round(begin + attempt["durationMs"]/1000, 3)
            intervals.append((begin, end))
            if not attempt.get("attemptIndex", 0):
                first_starts.append(begin)
            wrapper = "Flaky test passed this run" in attempt.get("error", {}).get("message", "")
            unexpected_pass = attempt["state"] == "passed" and t.get("expectedState") == "failed"
            outcome = "unexpected body error; wrapper passed unexpectedly" if unexpected_pass else "body passed; expected wrapper throw" if wrapper else "deliberate monthly sentinel" if sentinel else attempt["state"]
            n = add(suite, t["fullName"] + (f" · retry {attempt['attemptIndex']}" if attempt.get("attemptIndex") else ""), begin, end, "test",
                    f"{outcome} · worker {attempt.get('workerIndex')} / slot {attempt.get('parallelIndex')}",
                    "Playwright per-attempt telemetry", test=True, failed=unexpected_pass or (attempt["state"] not in ["passed", "skipped"] and not wrapper and not sentinel))
            for phase in attempt.get("phases", []):
                if phase["name"] in ["Before Hooks", "After Hooks", "create project fixture", "create mobile fixture", "connect admin itx"] and phase.get("startedAt") and phase.get("durationMs", 0) >= 100:
                    ps = sec(phase["startedAt"]); pe = round(ps+phase["durationMs"]/1000, 3)
                    if begin-.002 <= ps <= pe <= end+.002:
                        add(n, phase["name"], ps, pe, "other", "Fixed-name fixture phase; dynamic data remains private.", "Playwright step telemetry")

for r in app_reports:
    parent = job_nodes["apps"]
    start, end = sec(r["run"]["startedAt"]), sec(r["run"]["finishedAt"])
    suite = add(parent, f"{r['context']['app']} · {r['context']['framework']}", start, end, "test", "App suite reporter interval.", "Test telemetry")
    if r["context"].get("app") == "os" and r["context"]["framework"] == "vitest":
        for t in r["tests"]:
            for attempt in t.get("attempts", []):
                if attempt.get("startedAt") and attempt.get("durationMs"):
                    begin = sec(attempt["startedAt"])
                    add(suite, t["fullName"], begin, round(begin+attempt["durationMs"]/1000, 3), "test", f"{attempt['state']} · attempt {attempt.get('attemptIndex', 0)}", "Vitest attempt telemetry", test=True)

assert len(root_reports) == 6, f"Expected six reporters, found {len(root_reports)}"
assert len(catalogue) == len(set(catalogue)), "Duplicate tests across shards"
active = peak = 0
for _, delta in sorted([(s, 1) for s, e in intervals] + [(e, -1) for s, e in intervals]):
    active += delta; peak = max(peak, active)
lengths = sorted(e-s for s, e in intervals)
vitest = next(r for r in app_reports if r["context"].get("app") == "os" and r["context"]["framework"] == "vitest")
metrics = dict(result="success" if wf["status"] == "finished" else wf["status"], playwright=max(r["run"]["durationMs"]/1000 for r in root_reports),
               vitest=vitest["run"]["durationMs"]/1000, browserRetries=retries,
               appRetries=sum(t.get("retryCount", 0) for r in app_reports for t in r["tests"]), browserGreen=green,
               browserSkipped=skipped, browserBodyFailures=failures, browserSentinelFailures=sentinel_failures, peakActiveAttempts=peak,
               firstStartSpread=max(first_starts)-min(first_starts), attemptDurationMedian=statistics.median(lengths),
               attemptDurationP95=lengths[math.ceil(len(lengths)*.95)-1], attemptDurationMax=max(lengths), activeAttemptSeconds=sum(lengths),
               erase=[d for _, _, d, _ in sorted(erasings, key=lambda e:e[1])],
               resourceSummary="Nine separate runners. Select a job in the trace for its sampled peak CPU/memory; no single-machine percentage is meaningful for the whole workflow.",
               runnerSeconds=sum(j["end"]-j["start"] for j in job_nodes.values()),
               allocatedCpuMinutes=sum((j["end"]-j["start"])*(4 if key == "finish" else 16)/60 for key,j in job_nodes.items()))
for n in nodes:
    n["children"].sort(key=lambda c: c["order"] if n is root else c["start"])
    for c in n["children"]:
        assert n["start"]-.2 <= c["start"] <= c["end"] <= n["end"]+.2, (n["label"], c["label"], c["start"], c["end"])
# Union of actual install intervals; it is not a counterfactual speedup estimate.
merged = []
for i in sorted(installs, key=lambda i:i["start"]):
    if merged and i["start"] <= merged[-1][1]: merged[-1][1] = max(merged[-1][1], i["end"])
    else: merged.append([i["start"], i["end"]])
ready_signal = next(t for t, line in prep if "[ci:status] reached ci/" in line and line.endswith("/preview-ready"))
consumer_end = max(job_nodes[key]["end"] for key in job_order if key not in ["prepare", "finish"])
prepare_install = next(i["end"]-i["start"] for i in installs if i["job"] == "Prepare")
consumer_install_tail = max([0] + [i["end"]-ready_signal for i in installs if i["job"] not in ["Prepare", "Teardown + reporting"]])
finish_install_tail = max([0] + [i["end"]-consumer_end for i in installs if i["job"] == "Teardown + reporting"])
record = dict(root=root, total=root["end"], run=m["run"]["run_id"], workflow=wf["workflow_id"], head=m["run"]["head_sha"],
              label=a.label, normal=False, overlappedSetup=True, groupedShardPhases=True, workers=16, shards=6, slot=erasings[0][3] if erasings else "unknown", metrics=metrics,
              installs=installs, installWall=prepare_install+consumer_install_tail+finish_install_tail, installUnion=sum(e-s for s,e in merged), installTail=finish_install_tail, installSum=sum(i["end"]-i["start"] for i in installs),
              windows={"prepare":[job_nodes["prepare"]["start"],job_nodes["prepare"]["end"]], "tests":[min(first_starts),wait_end], "finish":[job_nodes["finish"]["start"],root["end"]]},
              browserWindow=[min(sec(r["run"]["startedAt"]) for r in root_reports),max(sec(r["run"]["finishedAt"]) for r in root_reports)],
              catalogueCount=len(catalogue), catalogueHash=hashlib.sha256(json.dumps(sorted(catalogue)).encode()).hexdigest(),
              context=f"Nine jobs; six × sixteen browser workers. Run {m['run']['run_id']}; commit {m['run']['head_sha'][:9]}.",
              findings=f"{green} browser bodies passed, {skipped} skipped, {failures-sentinel_failures} body failures, {sentinel_failures} deliberate sentinel outcomes. {retries} browser retries. Setup overlaps readiness; cleanup waits for all consumers.")
(here / "runs" / f"{a.key}.json").write_text(json.dumps(record, separators=(",", ":"))+"\n")
print(json.dumps({"total":record["total"], **metrics}, indent=2))
