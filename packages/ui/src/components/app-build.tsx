import { useEffect, useEffectEvent, useState } from "react";
import type { BuildStanding } from "iterate/pkg-pr-new";
import { Button } from "./button.tsx";
import { Spinner } from "./spinner.tsx";

/** What `check` answered for one installed version, or why it could not. */
type Checked = { installed: string } & ({ standing: BuildStanding } | { error: string });

/** How the last upgrade from this page ended. */
type Outcome = { kind: "upgraded"; from: string; to: string } | { kind: "failed"; error: string };

/**
 * AN INSTALLED APP'S BUILD, and its upgrade to main's newest: the Agents app's sidebar and the Voice
 * page. `check` says where the installed build stands (iterate/pkg-pr-new
 * `buildStanding`, which the app's Worker runs), asked again whenever `installed` changes; while it
 * runs the section says so, and a check that fails says why, with Check again. A build main has a
 * newer one of offers "Upgrade to the newest", which runs `upgrade` (the app's commit of the new pin
 * and its install, then the page's reload) and says how it ended: the two commits, or the error. The
 * section knows no SDK: the app hands it both calls.
 */
export function AppBuild({
  app,
  installed,
  check,
  upgrade,
}: {
  /** the app's name, which titles the section: "Agents", "Voice" */
  app: string;
  /** the version the project runs: its published config's pin, which a refused upgrade leaves */
  installed: string;
  check: (installed: string) => Promise<BuildStanding>;
  /** Upgrades the project to `version` and reloads the page's data; throws what failed. */
  upgrade: (version: string) => Promise<void>;
}) {
  const [checked, setChecked] = useState<Checked>();
  const [attempt, setAttempt] = useState(0);
  const [upgrading, setUpgrading] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>();
  const ask = useEffectEvent((version: string) => check(version));
  useEffect(() => {
    let current = true;
    ask(installed).then(
      (standing) => current && setChecked({ installed, standing }),
      (error: unknown) =>
        current &&
        setChecked({ installed, error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      current = false;
    };
  }, [installed, attempt]);
  // a check of another installed version (the one before an upgrade) is not this one's answer
  const answer = checked?.installed === installed ? checked : undefined;
  const onUpgrade = async (behind: Behind) => {
    setUpgrading(true);
    setOutcome(undefined);
    try {
      await upgrade(behind.version);
      setOutcome({ kind: "upgraded", from: behind.installed, to: behind.newest });
    } catch (error) {
      setOutcome({ kind: "failed", error: error instanceof Error ? error.message : String(error) });
    } finally {
      setUpgrading(false);
    }
  };
  return (
    <section
      aria-label={`${app} build`}
      className="flex min-w-0 flex-col gap-2 text-xs text-muted-foreground"
    >
      <p className="font-medium text-foreground">{app} build</p>
      {!answer ? (
        <p className="flex items-center gap-1.5">
          <Spinner className="size-3" /> Checking main for a newer build…
        </p>
      ) : "error" in answer ? (
        <>
          <p role="alert" data-type="error" className="break-words text-destructive">
            Could not check main for a newer build: {answer.error}
          </p>
          <div>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                setChecked(undefined);
                setAttempt((n) => n + 1);
              }}
            >
              Check again
            </Button>
          </div>
        </>
      ) : (
        <Standing
          standing={answer.standing}
          upgrading={upgrading}
          onUpgrade={(behind) => void onUpgrade(behind)}
        />
      )}
      {outcome?.kind === "upgraded" ? (
        <p role="status" className="text-foreground">
          Upgraded from <Commit sha={outcome.from} /> to <Commit sha={outcome.to} />.
        </p>
      ) : outcome?.kind === "failed" ? (
        <p role="alert" data-type="error" className="break-words text-destructive">
          {outcome.error}
        </p>
      ) : null}
    </section>
  );
}

type Behind = Extract<BuildStanding, { kind: "behind" }>;

/** Where the installed build stands, in a sentence, and the upgrade when main has a newer one. */
function Standing({
  standing,
  upgrading,
  onUpgrade,
}: {
  standing: BuildStanding;
  upgrading: boolean;
  onUpgrade: (behind: Behind) => void;
}) {
  switch (standing.kind) {
    case "own":
      return (
        <p className="break-all">
          The project's own build, <span className="font-mono">{standing.installed}</span>, which it
          upgrades itself.
        </p>
      );
    case "newest":
      return (
        <p>
          <Commit sha={standing.installed} />, the newest on main.
        </p>
      );
    case "ahead":
      return (
        <p>
          <Commit sha={standing.installed} />, newer than main's newest,{" "}
          <Commit sha={standing.newest} />.
        </p>
      );
    case "behind":
      return (
        <>
          <p>
            <Commit sha={standing.installed} />. Main has a newer one,{" "}
            <Commit sha={standing.newest} /> (
            <a
              className="underline underline-offset-2 hover:text-foreground"
              href={`https://github.com/iterate/iterate/compare/${standing.installed}...${standing.newest}`}
              target="_blank"
              rel="noreferrer"
            >
              what changed
            </a>
            ).
          </p>
          <div>
            <Button size="sm" disabled={upgrading} onClick={() => onUpgrade(standing)}>
              {upgrading ? (
                <>
                  <Spinner data-icon="inline-start" /> Upgrading…
                </>
              ) : (
                "Upgrade to the newest"
              )}
            </Button>
          </div>
        </>
      );
  }
}

/** A build's commit, short, linked to it on GitHub. */
function Commit({ sha }: { sha: string }) {
  return (
    <a
      className="font-mono underline underline-offset-2 hover:text-foreground"
      href={`https://github.com/iterate/iterate/commit/${sha}`}
      target="_blank"
      rel="noreferrer"
      title={sha}
    >
      {sha.slice(0, 7)}
    </a>
  );
}
