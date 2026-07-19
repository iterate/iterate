type CloudflareAccountFetch = (path: string, init?: RequestInit) => Promise<unknown>;

type ContainerHealth = {
  errors?: unknown[];
  instances?: {
    active?: number;
    assigned?: number;
    failed?: number;
    healthy?: number;
    scheduling?: number;
    starting?: number;
    stopped?: number;
  };
};

type ContainerApplication = {
  health?: ContainerHealth;
  id: string;
  instances?: number;
  name: string;
};

type ContainerRollout = {
  health?: ContainerHealth;
  id: string;
  progress?: {
    total_instances?: number;
    updated_instances?: number;
    version_distribution?: {
      target_version_percentage?: number;
    };
  };
  status: "completed" | "pending" | "progressing" | "replaced" | "reverted" | string;
  steps?: Array<{ status?: string }>;
  target_version?: number;
};

type RolloutState = {
  application: ContainerApplication;
  rollout: ContainerRollout | null;
};

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 90_000;

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function healthProblems(health: ContainerHealth | undefined, expectedInstances?: number): string[] {
  if (!health) return ["health is absent"];
  const problems: string[] = [];
  if ((health.errors?.length ?? 0) > 0) {
    problems.push(`errors=${JSON.stringify(health.errors)}`);
  }
  const instances = health.instances;
  if (!instances) return [...problems, "instance health is absent"];
  if ((instances.failed ?? 0) > 0) problems.push(`failed=${instances.failed}`);
  if ((instances.scheduling ?? 0) > 0) problems.push(`scheduling=${instances.scheduling}`);
  if ((instances.starting ?? 0) > 0) problems.push(`starting=${instances.starting}`);
  // Cloudflare partitions settled placements by lifecycle: an idle slot is
  // `healthy`, while a running container moves to `active` (and therefore no
  // longer contributes to `healthy`). `assigned` and `stopped` are also
  // non-provisioning states. Requiring `healthy === instances` made a fully
  // active builder pool look permanently unready.
  const readyInstances =
    (instances.active ?? 0) +
    (instances.assigned ?? 0) +
    (instances.healthy ?? 0) +
    (instances.stopped ?? 0);
  if (expectedInstances !== undefined && readyInstances < expectedInstances) {
    problems.push(`ready=${readyInstances}/${expectedInstances}`);
  }
  return problems;
}

function completedRolloutProblems(rollout: ContainerRollout): string[] {
  const progress = rollout.progress;
  const problems: string[] = [];
  if (!rollout.health) {
    problems.push("health is absent");
  } else {
    if ((rollout.health.errors?.length ?? 0) > 0) {
      problems.push(`errors=${JSON.stringify(rollout.health.errors)}`);
    }
    if (!rollout.health.instances) {
      problems.push("instance health is absent");
    } else if ((rollout.health.instances.failed ?? 0) > 0) {
      problems.push(`failed=${rollout.health.instances.failed}`);
    }
  }
  if (!progress) return [...problems, "progress is absent"];
  if (progress.updated_instances !== progress.total_instances) {
    problems.push(
      `updated=${progress.updated_instances ?? "unknown"}/${progress.total_instances ?? "unknown"}`,
    );
  }
  const targetPercentage = progress.version_distribution?.target_version_percentage;
  if (targetPercentage !== undefined && targetPercentage !== 100) {
    problems.push(`target-version=${targetPercentage}%`);
  }
  const incompleteSteps = rollout.steps?.filter((step) => step.status !== "completed").length ?? 0;
  if (incompleteSteps > 0) problems.push(`incomplete-steps=${incompleteSteps}`);
  return problems;
}

function describeState(state: RolloutState): string {
  const rollout = state.rollout;
  if (!rollout) {
    const problems = healthProblems(state.application.health, state.application.instances);
    return `${state.application.name}: no rollout${
      problems.length > 0 ? ` (${problems.join(", ")})` : " (ready)"
    }`;
  }
  const progress = rollout.progress;
  const problems = rollout.status === "completed" ? completedRolloutProblems(rollout) : [];
  return (
    `${state.application.name}: ${rollout.status} rollout=${rollout.id}` +
    (progress
      ? ` updated=${progress.updated_instances ?? "?"}/${progress.total_instances ?? "?"}`
      : "") +
    (problems.length > 0 ? ` (${problems.join(", ")})` : "")
  );
}

function assertTerminalState(state: RolloutState): void {
  const rollout = state.rollout;
  if (!rollout) {
    const problems = healthProblems(state.application.health, state.application.instances);
    if (problems.length > 0) {
      throw new Error(
        `Container application ${state.application.name} has no rollout and is not ready: ${problems.join(
          ", ",
        )}.`,
      );
    }
    return;
  }
  if (rollout.status !== "completed") {
    throw new Error(
      `Container rollout did not complete for ${state.application.name}: ${describeState(state)}.`,
    );
  }
  const problems = completedRolloutProblems(rollout);
  if (problems.length > 0) {
    throw new Error(
      `Container rollout completed unhealthily for ${state.application.name}: ${problems.join(
        ", ",
      )} (rollout=${rollout.id}, target-version=${rollout.target_version ?? "unknown"}).`,
    );
  }
}

function isInProgress(state: RolloutState): boolean {
  if (state.rollout) {
    if (state.rollout.status === "pending" || state.rollout.status === "progressing") return true;
    if (state.rollout.status !== "completed") return false;

    // A completed, fully updated rollout has finished replacing the old
    // deployment. An updated instance can still be starting as part of its
    // ordinary workload lifecycle; that cannot expose the previous image and
    // is not rollout work. Keep health errors and failed instances terminal,
    // while polling only incomplete rollout progress.
    const health = state.rollout.health;
    if ((health?.errors?.length ?? 0) > 0 || (health?.instances?.failed ?? 0) > 0) return false;
    return completedRolloutProblems(state.rollout).length > 0;
  }
  const health = state.application.health;
  if ((health?.errors?.length ?? 0) > 0 || (health?.instances?.failed ?? 0) > 0) return false;
  return healthProblems(health, state.application.instances).length > 0;
}

async function getLatestRollout(
  cf: CloudflareAccountFetch,
  application: ContainerApplication,
  signal: AbortSignal,
): Promise<RolloutState> {
  const rollouts = (await cf(
    `/containers/applications/${encodeURIComponent(application.id)}/rollouts?limit=1`,
    { signal },
  )) as ContainerRollout[];
  return { application, rollout: rollouts[0] ?? null };
}

/**
 * Wrangler returns after it creates Container rollouts, not after those
 * rollouts replace every assigned instance. Preview tests create sandboxes
 * immediately, so they must not become eligible until every configured app
 * reports a completed, 100%-updated rollout without health errors or failed
 * instances. Starting or scheduling an already-updated instance is ordinary
 * workload lifecycle rather than evidence that the old deployment remains.
 */
export async function waitForContainerRollouts(input: {
  applicationNames: readonly string[];
  cf: CloudflareAccountFetch;
  pollIntervalMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  timeoutMs?: number;
}): Promise<{ applications: number; pendingApplications: number }> {
  const applicationNames = [...new Set(input.applicationNames)].sort();
  if (applicationNames.length === 0) return { applications: 0, pendingApplications: 0 };

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const controller = new AbortController();
  let states: RolloutState[] = [];
  const timeout = setTimeout(() => {
    controller.abort(
      new Error(
        `Container rollouts did not settle within ${(timeoutMs / 1_000).toFixed(1)}s: ${
          states.length > 0 ? states.map(describeState).join("; ") : "state unavailable"
        }.`,
      ),
    );
  }, timeoutMs);

  try {
    const applications = (await input.cf("/containers/applications?per_page=1000", {
      signal: controller.signal,
    })) as ContainerApplication[];
    const selected = applicationNames.map((name) => {
      const matches = applications.filter((application) => application.name === name);
      const match = matches[0];
      if (matches.length !== 1 || !match) {
        throw new Error(
          `Expected exactly one Cloudflare Container application named ${name}, found ${matches.length}.`,
        );
      }
      return match;
    });

    states = await Promise.all(
      selected.map((application) => getLatestRollout(input.cf, application, controller.signal)),
    );
    const pendingApplications = states.filter(isInProgress).length;
    if (pendingApplications > 0) {
      console.log(
        `Waiting for ${pendingApplications}/${states.length} Container applications: ${states
          .filter(isInProgress)
          .map(describeState)
          .join("; ")}`,
      );
    }

    const sleep = input.sleep ?? abortableDelay;
    while (states.some(isInProgress)) {
      await sleep(pollIntervalMs, controller.signal);
      states = await Promise.all(
        states.map((state) => {
          const rollout = state.rollout;
          if (!isInProgress(state)) return state;
          if (!rollout) {
            return input
              .cf(`/containers/applications/${encodeURIComponent(state.application.id)}`, {
                signal: controller.signal,
              })
              .then((application) => ({
                application: application as ContainerApplication,
                rollout: null,
              }));
          }
          return input
            .cf(
              `/containers/applications/${encodeURIComponent(state.application.id)}/rollouts/${encodeURIComponent(rollout.id)}`,
              { signal: controller.signal },
            )
            .then((nextRollout) => ({ ...state, rollout: nextRollout as ContainerRollout }));
        }),
      );
    }

    for (const state of states) assertTerminalState(state);
    console.log(
      `Container readiness settled: ${states.length} applications, ${pendingApplications} pending after Wrangler returned.`,
    );
    return { applications: states.length, pendingApplications };
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
