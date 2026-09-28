// github-sync/contract.ts — THE GITHUB SYNC: a project's repo (`/repos/config` unless the install
// names another) and its origin on GitHub are ONE history on two remotes, and the platform's `pull()`
// and `push()` move the same commits both ways (same oids, fast-forward only). processor.ts only says
// when:
//
//   on /integrations/github/<connection>  a push to origin's main  → repo.pull()  (which publishes)
//   on /                                  a commit to the repo     → repo.push()
//
// What one side just received is already there when the other side's event arrives, so that call
// answers up-to-date and nothing loops. Diverged mains are the outcome `not-fast-forward`: a person
// chooses in the Dash (the project's Config repo: replace with GitHub's, or push iterate's). Every
// call's outcome is a `github-sync/synced` fact on the log that saw its trigger. `github-sync/installed`
// (install.ts appends it to both logs) names the repo; the history before it is never synced.
import { z } from "zod";
import { defineProcessorContract } from "iterate/stream/processor";

export const GithubSyncContract = defineProcessorContract({
  slug: "github-sync",
  version: "3",
  description:
    "Pulls origin's pushes into the installed repo and pushes the repo's commits to origin.",
  stateSchema: z.object({ repo: z.string().nullable().default(null) }),
  consumes: [
    "events.iterate.com/github/webhook-received",
    "events.iterate.com/repo/commit-completed",
    "github-sync/installed",
  ],
  emits: ["github-sync/synced"],
});
