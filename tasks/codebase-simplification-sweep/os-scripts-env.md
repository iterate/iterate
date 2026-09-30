# Sweep candidates: os-scripts-env

Verified candidates from the 2026-09-29 codebase simplification sweep for this area. Each passed an adversarial skeptic check; where the skeptic amended the proposal, the amendment wins. Line numbers are as of origin/main on 2026-09-29 (about cfd8a1d36) and have drifted since: #3442, #3455 and #3460 touched some of these files. The index and the owner calls are in ../codebase-simplification-sweep.md.

## One `appEnvs` map in envs.ts instead of six per-app maps and five hand-kept app lists, which have already drifted (admin never pages)

- Sweep index: 38; risk: low; payoff: 6/10
- LOC: About −115 to −150 net, measured with sed and wc, touching about 15 files mechanically:
- envs.ts: about −115. The maps are 129 lines, plus 10 for PREVIEW_DEPLOYMENT_APPS and 20 for the types, and the new map is about 40.
- start-app.ts: about −30.
- The six app.ts files: −12.
- preview-config.ts: about −5.
- preview.test.ts: about −4.
- prd-fault-alarm.ts: about −6. (skeptic measured: Measured on a prototype, using wc -l:
- envs.ts: 513 → 402 (−111). The six maps, KitEnv, PREVIEW_DEPLOYMENT_APPS, DummyPetshopEnv and the ci-reports inline type go; AppEnv, mainOnDev, onPrd and the 12-line appEnvs come in. Reusing mainOnDev inside previewDeployment saves about 7 more.
- scripts/lib/start-app.ts: 339 → about 310 (−29). The import block, StartAppEnv and the FIRST_PARTY_APPS literal shrink to a 4-line typed alias.
- scripts/ci/prd-fault-alarm.ts: 1367 → about 1354 (−13 after formatting).
- apps/os/scripts/preview-config.ts: 373 → 372 (−1). Six app.ts imports become a 5-line derivation.
- apps/os/scripts/preview.test.ts: −4 (the guard row).
- Renames only, 0 lines: the six app.ts files, start-app.test.ts, apps/kit device-auth.ts and firmware-release.ts, and preview-sweep.ts.
- Docs: the dash, voice, notes and admin READMEs get one-word edits; the creating-an-app SKILL.md loses 2 table rows; start-app-config.ts and apps/notes/config-worker.ts get comment fixes.
- Net about −158 lines of code over about 15 files.)
- Concepts: About 13 concepts become 3.
- Before: 6 named maps, KitEnv, StartAppEnv, and 4 or 5 name lists.
- After: appEnvs, AppEnv, and one derived list.

### Evidence

Merges the parallel and heavy hunts.

The six per-app maps in envs.ts:

- :69-101 (kit, with `KitEnv`)
- :244-343 (dash, agents, notes, admin, voice)
- 129 lines in all, identical apart from the name, except kit's prd (`kiterate`, `k.iterate.com`).
- envs.ts:374-407 `previewDeployment` already derives the per-commit app envs by this same convention.

The same six names are kept again in:

- envs.ts:350-357 PREVIEW_DEPLOYMENT_APPS; its docstring at :349 names a dead `ITERATE_APP_ORIGINS`.
- scripts/lib/start-app.ts:37-69 (StartAppEnv, FIRST_PARTY_APPS).
- apps/os/scripts/preview-config.ts:39 APPS, built from six apps/*/scripts/app.ts files.
- scripts/ci/prd-fault-alarm.ts:66-77 PRD_WORKERS.
- knip.ts:104.

apps/os/scripts/preview.test.ts:93-95 exists only to keep two of those lists equal.

The lists have already drifted:

- PRD_WORKERS ('Every first-party Worker in production') omits admin, added in #3144. A 5xx on admin.iterate.com never pages, and prd-fault-alarm.test.ts:719 pins that gap.
- preview.ts:850 still records `agents` as a spec target after #3446 deleted that project.

The same env shape is re-declared as DummyPetshopEnv (envs.ts:457-463) and as ci-reports' inline type (:479-482).

### Current shape

Every app on top of apps/os spells its two deployments by hand, following one convention nobody varies. Four or five other places then list the apps again by hand, with a test guarding two of them while a third has drifted unguarded.

### Proposed shape

```ts
export interface AppEnv { cloudflareAccountId: string; dopplerConfig: string; workerName: string; baseUrl: string; posthogProjectKey?: string }
const mainOnDev = (app: string): AppEnv => ({ cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID, dopplerConfig: 'preview', workerName: app, baseUrl: `https://${app}.${PREVIEW_WORKERS_DEV}` });
const onPrd = (workerName: string, baseUrl: string): AppEnv => ({ cloudflareAccountId: PRD_ACCOUNT_ID, dopplerConfig: 'prd', workerName, baseUrl, posthogProjectKey: ITERATE_POSTHOG_PROJECT_KEY });
export const appEnvs = {
  dash: { preview: mainOnDev('dash'), prd: onPrd('dash', 'https://dash.iterate.com') }, agents: …, notes: …, admin: …, voice: …,
  kit: { preview: mainOnDev('kit'), prd: onPrd('kiterate', 'https://k.iterate.com') },
} satisfies Record<Exclude<keyof StartAppConfig['urls'], 'os'>, { preview: AppEnv; prd: AppEnv }>;
```

Everything else reads the map:

- `previewDeployment`, FIRST_PARTY_APPS, preview-config APPS and PRD_WORKERS, which becomes `[osEnvs.prd, ...Object.values(appEnvs).map((e) => e.prd), spaEnvs.prd]`.
- runSuite's base URLs and its evidence list.

What goes:

- KitEnv, StartAppEnv, DummyPetshopEnv and the ci-reports type become `AppEnv`.
- The preview.test.ts:93 row is deleted.
- The six apps/*/scripts/app.ts `envs:` fields are dropped.

### What changes

Every worker name, origin, account, Doppler config and PostHog key comes out the same.

Two intended fixes:

- admin joins the prd fault alarm's service filter, so its 5xx now pages. This assumes the omission was drift, not a choice.
- The specs' evidence target stops naming `agents`.

This reshapes envs.ts, which docs/jonasland-rules.md asks to confirm with a human first.

### Pinned by

- apps/os/scripts/preview.test.ts:61, and :93 (deleted)
- scripts/lib/start-app.test.ts:6, 27-41, 43-77
- scripts/ci/prd-fault-alarm.test.ts:719 (the filter string gains admin)
- apps/kit/src/device-auth.ts:46 and apps/kit/scripts/firmware-release.ts:541 read kitEnvs.prd.baseUrl

### Skeptic's amended proposal

One `appEnvs` map in envs.ts:

```ts
export interface AppEnv { cloudflareAccountId: string; dopplerConfig: string; workerName: string; baseUrl: string; posthogProjectKey?: string }
const mainOnDev = (app: string): AppEnv => ({ cloudflareAccountId: PREVIEW_AND_DEV_ACCOUNT_ID, dopplerConfig: "preview", workerName: app, baseUrl: `https://${app}.${PREVIEW_WORKERS_DEV}` });
const onPrd = (workerName: string, baseUrl: string): AppEnv => ({ cloudflareAccountId: PRD_ACCOUNT_ID, dopplerConfig: "prd", workerName, baseUrl, posthogProjectKey: ITERATE_POSTHOG_PROJECT_KEY });
export const appEnvs = {
  dash: { preview: mainOnDev("dash"), prd: onPrd("dash", "https://dash.iterate.com") },
  … agents, notes, admin, voice …,
  kit: { preview: mainOnDev("kit"), prd: onPrd("kiterate", "https://k.iterate.com") },
};
```

Each app's special note becomes a one-line comment on its entry. The repeated main-on-dev paragraph becomes mainOnDev's docstring.

What derives from the map:

- `previewDeployment` apps: `Object.fromEntries(Object.keys(appEnvs).map((app) => [app, mainOnDev(`${name}-${app}`)]))`.
- preview-sweep: `["os", ...Object.keys(appEnvs)]`.
- start-app.ts: `const FIRST_PARTY_APPS: Record<Exclude<keyof StartAppConfig["urls"], "os">, Record<string, AppEnv>> = appEnvs;` StartAppEnv is deleted in favour of AppEnv.
- preview-config.ts: `APPS = Object.entries(appEnvs).map(([name, envs]) => ({ name, root: new URL(`../../${name}/`, import.meta.url), envs }))`, which drops the six app.ts imports.
- prd-fault-alarm.ts: `PRD_WORKERS = [osEnvs.prd!, ...Object.values(appEnvs).map((e) => e.prd), spaEnvs.prd].map((e) => e.workerName)`. This adds admin, so its 5xx now page; get Jonas's OK. The test at :719 is updated.

What is deleted:

- KitEnv, DummyPetshopEnv, the ci-reports inline type (all become AppEnv), and PREVIEW_DEPLOYMENT_APPS.
- The preview.test.ts:93 guard row.

What changes in name only:

- app.ts files keep `envs: appEnvs.<name>`, changing only their import.
- kit's `kitEnvs.prd.baseUrl` becomes `appEnvs.kit.prd.baseUrl`.
- The READMEs and the creating-an-app SKILL table drop the FIRST_PARTY_APPS and APPS registration rows.

Out of scope: runSuite's spec base URLs and evidence list, which cover the Playwright app subset, not every app. The stale `agents` at preview.ts:850 is a separate one-word fix.

### Skeptic's verdict

The core claim holds. I rebuilt envs.ts with the proposed one `appEnvs` map in scratchpad/proto/envs.ts and imported both versions with node. All 12 app envs (6 apps × preview/prd) come out field-for-field identical. So do `previewDeployment("pr3144-a1b2c3d")`, `osEnvs`, `spaEnvs`, `dummyPetshopEnvs` and `ciReportsEnvs`. The keys match PREVIEW_DEPLOYMENT_APPS in the same order.

The drift is real:

- #3057 built PRD_WORKERS as "every first-party Worker". #3144 then added `adminEnvs` and `deploy-admin.yml` but never updated PRD_WORKERS. prd-fault-alarm.test.ts:719, titled "every first-party prd Worker is read", pins the gap.
- The creating-an-app skill's registration table does not list PRD_WORKERS at all, which is how the gap happened.
- envs.ts:349 points at a dead `ITERATE_APP_ORIGINS`.
- preview.test.ts:93 exists only to keep APPS and PREVIEW_DEPLOYMENT_APPS equal.

The new shape really is simpler:

- The six maps repeat one block, and the same "X AT MAIN on the dev/preview account..." comment six times.
- The only real difference is kit's prd, `kiterate` at `k.iterate.com`.
- `previewDeployment` already derives the per-commit set by exactly this convention.
- It fits his "conventions over frameworks" taste. No guarantee is dropped.

Behaviour that changes:

1. PRD_WORKERS gains `admin`. Admin's 5xx responses and errors start paging, and the Workers Logs `in` filter value becomes "os-prd,dash,agents,notes,admin,voice,kiterate,iterate-spa". It is still one leaf, so the node count is unchanged. prd-fault-alarm.test.ts:719 changes. The intent in #3057 says this was drift, but it is a real paging change for Jonas to OK.
2. APPS order goes from [dash, agents, notes, voice, kit, admin] to the map's order. Only the PR body's row order and the deploy log order change. The only test that reads APPS is the guard being deleted.
3. docs/jonasland-rules.md asks that a reshape of envs.ts be confirmed with a human first.

Where the candidate is mis-specified:

- (a) Deriving runSuite's base URLs and the evidence list from the map is wrong. The spec targets are the apps that have Playwright projects (notes, voice, dash, admin). Deriving them from appEnvs would add kit and agents. The stale `agents` at preview.ts:850 is separate: a one-word fix to metadata that only TestEvidenceTarget reads.
- (b) Dropping `envs:` from the six app.ts files needs `StartApp.name` keyed to appEnvs plus a cast wherever start-app.ts indexes by a string env. Keep `envs: appEnvs.<name>`. That counts as 0 lines, not −12.
- (c) FIRST_PARTY_APPS must stay as a roughly 4-line widened alias `Record<Exclude<keyof StartAppConfig['urls'],'os'>, Record<string, AppEnv>> = appEnvs`. linkedEnvironment indexes `envs[linked]` with a string, and the alias keeps the schema check. Assigning a variable loses the excess-key check that today's object literal has. Put the `satisfies` in envs.ts (a type-only import) if both directions matter.
- (d) The concept count is inflated but points the right way. Before there are about 15 concepts: 6 maps, KitEnv, StartAppEnv, DummyPetshopEnv, the ci-reports inline type, PREVIEW_DEPLOYMENT_APPS, 3 hand lists and 1 guard test. After there are about 4 (appEnvs, AppEnv, mainOnDev, onPrd), with 3 derived names and no hand lists.

Risk is low: config is identical and every other change is a mechanical rename.

## preview.ts: the class's methods are the commands, not method → command string → if-chain → function, and the dead `config` command goes

- Sweep index: 40; risk: low; payoff: 4/10
- LOC: About −70 across preview.ts and build.ts:
- The enum, options bag, class and main total 115 lines and become about 60.
- deployPreview goes from 22 lines to about 10.
- buildOs and the header lines account for about −8. (skeptic measured: I applied the change to scratch copies of both files, formatted them with oxfmt and diffed them with `git diff --no-index --stat`. preview.ts goes from 1374 to 1339 lines (+89/−124) and build.ts from 161 to 154 (−7), so the total is −42, not the claimed −70. The split: the commands section goes from 110 to 100 lines; the zod enum (13 lines with its blank), the `z` import, the `buildOs` import and the header's `config` line go (−16); `deploymentToTest` gains 3 lines; merging `deployPreview` saves 12; `buildOs` and its `viteBuild` import go from build.ts (−7). The candidate's "115 → ~60" only works if each flag's JSDoc is dropped, and trpc-cli uses those comments as the `--help` text, so they have to stay.)
- Concepts: Six concepts (the enum used only as a type, the all-flags bag, the forwarding class, the re-dispatching main, the wrapper, the dead command) become one: a class whose methods are the commands.

### Evidence

Merges the parallel and heavy hunts. All in apps/os/scripts/preview.ts:

- :130-141 `Command`, a zod enum used only as a type. `z` (:30) is imported for nothing else.
- :1267-1281 `PreviewOptions`, one bag holding every command's flags.
- :1284-1321 nine class methods, each calling `await main('<their own name>', options)`.
- :1323-1371 `main` dispatches on that string again through an if-chain.
- :396-417 `deployPreview` builds one `folded` promise and calls `deployPreviewSteps`; each has one caller.
- `config` (:7, :1358-1362) and build.ts:157-161 `buildOs` have no caller: git grep finds no `pnpm preview config`.

### Current shape

The CLI names each command three times: once in the enum, once as a forwarding method, and once in the if-chain. Every command accepts every flag and ignores most of them, and the deploy runs through a wrapper that adds nothing but one promise.

### Proposed shape

```ts
type Target = { pr?: string; name?: string };
type SuiteOptions = Target & { slowRows?: 'run' | 'skip' | 'only' };
export default class Preview {
  async deploy(options: Target & { apps?: 'all' | 'none'; dryRun?: boolean } = {}) { … await deployPreview(await accountContext(), thisCommit(options), options.pr, options.apps === 'none' ? [] : APPS); }
  async e2e(options: SuiteOptions = {}) { await runSuite('e2e', await suiteTarget(options), options.pr, options.slowRows); }
  async specs(options: SuiteOptions = {}) { … }
  async delete(options: Target & { dryRun?: boolean } = {}) { … }
  async sweep(options: { dryRun?: boolean; testRun?: boolean } = {}) { … }
  async deployParents() { … }
  async resetParent(options: { dryRun?: boolean } = {}) { … }
  async cleanupSuperseded(options: { dryRun?: boolean } = {}) { … }
}
```

Delete `Command`, `PreviewOptions`, `main`, `config` and `buildOs`. `deployPreview` absorbs `deployPreviewSteps`.

### What changes

- `pnpm preview config` and `buildOs` go; nothing calls them.
- Each command's --help lists only its own flags.
- A flag no command reads is refused instead of silently ignored.
- Every command and flag the workflows use keeps its name. `specs` still accepts `--slow-rows`, which preview-os.yml:334-336 passes.

### Pinned by

No unit test covers this. The workflow invocations pin the command names and flags:

- preview-os.yml:184, 334, 481
- main-os-e2e.yml:116, 195, 323
- preview-sweep.yml:62, 82
- preview-parents.yml:86
- preview-delete.yml:103
- os-latency.yml:69, 78
- os-real-model.yml:79, 88
- os-e2e-soak.yml:83

scripts/ci/preview-os-workflow.test.ts pins the preview-os command lines.

### Skeptic's amended proposal

One PR touching apps/os/scripts/preview.ts and build.ts. The class's methods become the commands.

```ts
type Target = { /** the pull request's number: its deployments are `pr<n>-<sha7>` */ pr?: string; /** the prefix's name, for a deployment with no PR */ name?: string };
type DryRun = { /** print the plan instead of acting */ dryRun?: boolean };
type Suite = Target & { /** e2e: which rows tagged `slow` run (scripts/slow-rows.ts); the specs have none */ slowRows?: "run" | "skip" | "only" };
const prefixOf = (options: Target) => resolvePreviewPrefix({ name: options.name, prNumber: options.pr });

export default class Preview {
  async deploy(options: Target & DryRun & { /** … */ apps?: "all" | "none" } = {}) {
    const name = previewDeploymentName(prefixOf(options), checkedOutCommit());
    // … today's body from main's tail: console.log, apps, dry-run print, GITHUB_OUTPUT …
    await deployPreview(await accountContext(), name, options.pr, apps);
  }
  async e2e(options: Suite = {}) { await runSuite("e2e", await deploymentToTest(prefixOf(options)), options.pr, options.slowRows); }
  async specs(options: Suite = {}) { await runSuite("specs", await deploymentToTest(prefixOf(options)), options.pr, options.slowRows); }
  async cleanupSuperseded(options: DryRun = {}) { /* the PREVIEW_DEPLOYMENT check, then */ await cleanupSuperseded((await accountContext()).cf, current, { dryRun: !!options.dryRun }); }
  async delete(options: Target & DryRun = {}) { const prefix = prefixOf(options); await deletePrefix({ cf: (await accountContext()).cf, prefix, prNumber: options.pr, dryRun: !!options.dryRun }); }
  async sweep(options: DryRun & { /** … */ testRun?: boolean } = {}) { await sweep((await accountContext()).cf, { dryRun: !!options.dryRun || !!options.testRun, testRun: !!options.testRun, onMain: …, jobUrl: … }); }
  async deployParents() { await deployParents(await accountContext()); }
  async resetParent(options: DryRun = {}) { await resetParent({ dryRun: !!options.dryRun }); }
}
```

**Also in the same PR:**

- **`deploymentToTest(prefix)`** begins with `if (process.env.PREVIEW_AWAIT_DEPLOY_JOB) return previewDeploymentName(prefix, checkedOutCommit());`, which moves that branch out of `main`.
- **Deploy becomes one function, `deployPreview`.**
  - It takes over `deployPreviewSteps`: the `folded` promise is computed at its top, before `assertFreshInstall`, and the `folded` parameter goes.
  - The two doc comments merge into one.
- **Deleted:**
  - the `Command` enum and the `z` import;
  - `PreviewOptions` and `main`;
  - the `config` command, its header line and the `buildOs` import;
  - `buildOs` itself and build.ts's `viteBuild` import.
- **Kept:** each flag's JSDoc, which is the `--help` text, and `run({ formatError: describe })`.

Measured: −42 LOC (preview.ts 1374→1339, build.ts 161→154). This was measured, not estimated.

### Skeptic's verdict

The claim holds, but the numbers were overstated.

**The smell is real and dates from a migration.** `git log -S` shows that `export default class Preview` and its forwarding methods came in with the mechanical trpc-cli conversion in #3146. That conversion wrapped the old argv dispatcher instead of replacing it.

- Every command is named three times: once in `Command` (:130-141), once as a method calling `main('<own name>')` (:1284-1321), and once in the if-chain in `main` (:1323-1371).
- `z` (:30) is imported for nothing but that enum.
- `PreviewOptions` (:1267-1281) gives every command every flag.
- This goes against docs/typescript-conventions.md, where the export's own options object is its flags. It is also hard to explain: "why does each method call main with its own name?"

**The shape works on the pinned trpc-cli 0.16.0.** I checked it with a probe in the scratchpad, not by reasoning.

- Inline intersections like `Target & DryRun & {apps?}` and `Suite = Target & {slowRows?}` are flattened into flags.
- Each command's `--help` shows only its own flags, with their JSDoc.
- `e2e --apps all` is refused with `error: unknown option '--apps'` and exit 1.

**What changes in behaviour:**

1. `pnpm preview config` goes, and so does `buildOs` (build.ts:155-158). Nothing calls either: not the workflows, not the README, not any script. `viteBuild` stays used by deploy-app.ts and start-app.ts.
2. A flag the command never read is now refused instead of ignored. Today that silence hides real footguns:
   - `deploy-parents --dry-run` deploys for real;
   - `e2e --dry-run` and `specs --dry-run` run the suite;
   - `cleanup-superseded --pr` or `--name` are ignored, and it uses PREVIEW_DEPLOYMENT.
3. Each command's `--help` lists only its own flags.
4. None: `deploymentToTest` takes over the `PREVIEW_AWAIT_DEPLOY_JOB` branch unchanged.
5. None: `deployPreview` takes over `deployPreviewSteps`, as long as the fold promise is still started first, before `assertFreshInstall`.

**Every caller keeps working.** I checked every invocation:

- **preview-os.yml:184, 334 and 481.** The suite line is shared by e2e and specs and passes `--pr`, `--name` and `--slow-rows`, so both suites need `slowRows`.
- **main-os-e2e.yml:116, 195 and 323.**
- **preview-sweep.yml:62 and 82.** They pass `--test-run` and nothing.
- **preview-parents.yml:86, preview-delete.yml:103, os-latency.yml:69 and 78, os-real-model.yml:79 and 88, and os-e2e-soak.yml:83.**
- **apps/os/scripts/e2e-soak.ts:253.** The candidate missed this one. It spawns `preview deploy --name X --apps none` and `preview delete --name X`, and both still work.
- **The README examples.** These include `sweep --dry-run` and `specs --name main`.

**No guarantee is dropped.** Nothing imports preview.ts. Tests pin only the command strings: scripts/ci/preview-os-workflow.test.ts reads the YAML, and those strings do not change. No test runs the CLI.

**Concepts: the "6 → 1" claim is overstated.**

- Before: a string enum used only as a type, one bag of every flag, a class that forwards, a `main` that dispatches again, a two-function deploy, and a dead command.
- After: a class whose methods are the commands, with three small option types (`Target`, `DryRun` and `Suite`) so each flag's JSDoc is written once. Deploy is one function.

That is about 6 → 2. The payoff is modest because this is a CI script, not platform code. Still, it removes a real double dispatch and a silent-ignore footgun, and it is not a lateral move.

**Risk is low.** To verify: `pnpm preview --help`, `pnpm preview deploy --name x --dry-run` (which needs no Cloudflare account), typecheck and knip.

## Remove deployApp's dead knobs: the afterDeploy hook nobody passes, and the UNPROVISIONED sentinel check nothing can trip

- Sweep index: 41; risk: low; payoff: 3/10
- LOC: About −35 across deploy-app.ts, env-context.ts and envs.ts. (skeptic measured: I applied the deletion to scratch copies and measured with wc -l. deploy-app.ts goes from 129 to 115 (−14), env-context.ts from 212 to 196 (−16) and envs.ts from 513 to 507 (−6), so the net is −36 (39 lines removed, 5 added where doc lines are reflowed).)
- Concepts: Three concepts go: the hook, the sentinel, and the assertion.

### Evidence

Merges the parallel and heavy hunts.

The afterDeploy hook:

- It lives at scripts/lib/deploy-app.ts:68-72 and :126, and the docs at :21-22, :31-32 and :74 describe it.
- None of deployApp's five callers passes it (os, spa, ci-reports, dummy-petshop, start-app.ts:206).
- tasks/complete/2026-09-29-deploy-target.md:44 records that moving the SPA onto it rested on a wrong premise.

The UNPROVISIONED sentinel:

- envs.ts:27-31 defines `UNPROVISIONED`.
- env-context.ts:145-158 `assertProvisioned` checks for it, and env-context.ts:5 imports envs.ts only for that check.
- deploy-app.ts:39-41 and :98 add a `resources` type parameter only to feed the check.
- `git log -S` shows the sentinel came in for preview slots (#2082, #2161), which were removed in #3165.
- No env holds the value, and ensure-resources.ts prints real ids.
- An env with no ids already provisions by name: generate-wrangler-config.ts:150-155 and deploy.ts:59 `ctx.env.resources?.dbId || createResources(ctx)`.

### Current shape

deployApp offers a post-deploy hook that nothing uses. Every deploy also scans resource ids for the literal 'UNPROVISIONED', which no env has held since per-commit deployments began creating their own resources.

### Proposed shape

- Delete `afterDeploy`, `UNPROVISIONED`, `assertProvisioned`, env-context's envs.ts import, and deployApp's `resources?` constraint.
- The pipeline doc then reads `… → deploy code+secrets → smoke-probe → ✅`.

### What changes

None: no caller passes the hook, and no env holds the sentinel.

### Pinned by

None. No test references afterDeploy, assertProvisioned or UNPROVISIONED.

### Skeptic's amended proposal

Everything below is a deletion in one PR, with no call-site changes.

scripts/lib/deploy-app.ts:

- Drop the `assertProvisioned` import.
- Drop the `resources?: Record<string, string>` member (and its doc) from the `E` constraint.
- Drop the `afterDeploy` option and its `await options.afterDeploy?.(ctx, secretValues)` call.
- Drop `if (env.resources) assertProvisioned(...)`.
- Cut the smokes doc to `/** Probed after the deploy, each until it answers healthy. */`, since the sentence pointing checks at `afterDeploy` is removed too.
- Re-flow the header to `resolve --env → collect secrets → app-specific prepare (config preflight, synced assets) → build (vite's, or the app's own) → deploy code+secrets in one version → smoke-probe → ✅`.
- End the header with "Apps with genuinely unique steps put them in `prepare`."

scripts/lib/env-context.ts:

- Delete `assertProvisioned` (lines 145-158) and the `import { UNPROVISIONED } from "../../envs.ts"`.

envs.ts:

- Delete the `UNPROVISIONED` const and its doc (lines 26-31).

Leave tasks/complete/2026-09-29-deploy-target.md alone, since it is a historical record.

Measured net: −36 lines. Check with `pnpm typecheck`; knip should stay clean, because nothing else imports these names. Rebase on #3448 if that merges first.

### Skeptic's verdict

(a) The semantics claim holds, checked against origin/main at b3daf4846, which already includes #3446.

- afterDeploy: `git grep afterDeploy` finds only its own definition and docs in scripts/lib/deploy-app.ts, plus the history note in tasks/complete/2026-09-29-deploy-target.md. None of the five deployApp callers passes it: apps/os, spa, ci-reports and dummy-petshop deploy.ts, and scripts/lib/start-app.ts:207. Its last caller was apps/kit/scripts/deploy.ts:43 (`verifyFirmwareAssets`), which #2948 deleted on 2026-09-24. #2947 then kept the hook, and so did #3429.
- UNPROVISIONED: only envs.ts:31 defines it, and env-context.ts:5 and :151 read it. The last env entries holding it were added for the prd-account e2e in #2921 and removed in #2933, both on 2026-09-24. The candidate's history is slightly off: the sentinel was born in #1636, not for the preview slots, and its last holder went in #2933, not #3165. The conclusion stands.
- Only OsEnv has `resources` (envs.ts:166), with the real ids of preview and prd. A per-commit deployment has no `resources`, and its deploy creates them itself (apps/os/scripts/deploy.ts:59, generate-wrangler-config.ts:147-152).
- For a brand-new envs.ts deployment, ensure-resources.ts:55-63 already prints the ids and exits 1 when envs.ts is missing them or they don't match.

Removing this changes no runtime behaviour on any path. The only thing lost is the ability to write an `UNPROVISIONED` placeholder in envs.ts, which is a convention nobody follows any more. No test references any of the three names.

(b) The new shape is really simpler, not a lateral move:

- the deployApp options lose a hook, the env constraint loses a field that existed only to feed the check, and a function goes;
- the pipeline doc loses two steps that never ran;
- scripts/lib/env-context.ts stops importing the root envs.ts, which drags in apps/os/src/test-email-domain.ts and a type from packages/iterate/src/project-ingress.ts, just for one string.

Three concepts go to zero.

(c) No real guarantee is dropped. The sentinel guarded a state that can no longer arise, and ensure-resources' mismatch check still covers the bring-up case.

(d) Measured at −36 rather than about −35.

Caveats:

- This is dead-code removal, not heavy machinery, so the payoff is modest.
- Open PR #3448 edits deploy-app.ts nearby (the import and the build doc comment), so whichever PR lands second needs a trivial rebase.

## Drop runSuite's specs warm-up process: 68 lines of process-group machinery for about 1 s

- Sweep index: 43; risk: low; payoff: 4/10
- LOC: About −99 in preview.ts. docs/ci-traces.md:88 loses one phrase. (skeptic measured: Both versions formatted with oxfmt. Amended shape: apps/os/scripts/preview.ts goes from 1374 to 1294 lines (+20/−100, net −80). Passing `--config playwright.config.ts` as today does, rather than relying on the default config lookup, makes the argument list wrap onto 9 lines; without that flag the change is about −88. The candidate's full deletion would be about −97. docs/ci-traces.md:88 is one phrase edit with a net change of 0 lines.)
- Concepts: The background warm-up process goes: its group, env scrub, stop protocol and span.

### Evidence

All in apps/os/scripts/preview.ts:

- :929-996 `warmUp` (68 lines):
  - its own process group
  - an env scrub of TEST_TELEMETRY_*, FLAKE_RECORD_DIR and CI_TRACE_ENABLED
  - a last-20-lines buffer
  - a trace span
  - a SIGTERM-then-SIGKILL `stop()`
- :772-790 builds it (specs only).
- :829-844 holds three `warm?.stop()` sites, plus a try/catch that exists only to stop it.

History: #3285 (1b9863b27) removed the other two warm-ups after measuring deploy end → first test unchanged without them. The same PR credits this one with '1.0 s each run'.

### Current shape

While the preview deploys, the specs job runs a detached `playwright test --list` to fill Playwright's transform cache. Every exit path of runSuite then has to stop it.

### Proposed shape

- Delete `warmUp` and its call sites.
- The wait becomes `if (deployJob) await traceOperation({ name: 'Wait for Deploy preview', phase: 'wait' }, () => awaitDeployOfThisRun(deployJob));`
- `runBounded` and `signalGroup` stay: the 30-minute suite bound is a real guarantee.

### What changes

A PR's first spec starts up to about 1.0 s later, the figure #3285 measured. Evidence, telemetry and bounds are unchanged.

### Pinned by

None.

### Skeptic's amended proposal

Keep the specs' transform-cache warm-up but drop all its concurrency machinery. Delete `warmUp` (apps/os/scripts/preview.ts:928-997) and the `const warm = ...` block (:773-790). Run the list awaited inside the specs branch of "Set up the suite", right after the Chromium install:

```ts
// While the preview deploys: --list compiles every spec into Playwright's transform cache,
// which the suite reads back (about 1 s), and runs no global setup, test or reporter.
if (deployJob)
  await runAsync("pnpm", ["exec", "playwright", "test", "--list", "--reporter=null"], {
    cwd: REPO_ROOT,
    env,
  }).catch((error) => console.warn(`[warm-up] ${describe(error)}; the suite runs anyway`));
```

The setup catch loses `await warm?.stop();`, and the wait becomes:

```ts
if (deployJob)
  await traceOperation({ name: "Wait for Deploy preview", phase: "wait" }, () =>
    awaitDeployOfThisRun(deployJob),
  );
```

`runBounded`, `signalGroup` and the `ChildProcess` import stay. In docs/ci-traces.md:88, "Set up the suite and the specs' warm-up as setup" becomes "Set up the suite as setup".

This is justified by 20 of 20 recent shard logs: the warm-up takes 1.2-1.7 s, while the deploy wait lasts 40-70 s, so the kill-at-deploy-end protocol never fires. Deleting the warm-up outright, as the candidate proposed, would instead give up the roughly 1.0 s per shard that #3285 measured and deliberately kept.

### Skeptic's verdict

The diagnosis holds but the remedy is wrong, so I'm amending it.

**What holds.** The current code is heavy machinery for a race that never happens. `warmUp` (apps/os/scripts/preview.ts:928-997) is a generic helper with one caller left. #3285 removed its other two users. It carries a detached process group, an env scrub, a 20-line output tail, its own trace span and a SIGTERM-then-SIGKILL `stop()`. On top of that, runSuite has three `warm?.stop()` sites (:830, :839, :843) and a try/catch around the wait that exists only to stop it.

I pulled the Depot logs of 20 recent PR specs-shard attempts (matrix-0 and matrix-3 of 10 runs). In every one:

- the warm-up finished on its own in 1.2-1.7 s;
- the deploy wait ended 39.8-70.4 s after the warm-up started;
- "Set up the suite" itself took about 0.5 s.

So `stop()` never kills anything in practice. The concurrency protocol guards a state that does not occur.

**What is wrong with deleting it outright.** The warm-up pays for itself:

- #3285 (1b9863b27, two days ago) deliberately kept exactly this warm-up and credits it with 1.0 s each run.
- The post-review measurement the candidate cites (deploy end to first test unchanged) was taken with the other two warm-ups gone and this one still running. It does not cover removing this one.
- Browser specs' deploy-end-to-first-test p50 is 2.1 s, the gap #3271 was built to shrink. Deleting the warm-up gives back roughly half of that on every shard.
- Local check: with the transform cache cold, `playwright test --list` took about 6.2 s median; warm, about 4.0 s (noisy, load average above 50). That is consistent with the 1 s CI figure.

Deleting it is a real, measured regression that the owner explicitly chose to avoid. It is not "almost identical".

**The simpler shape keeps the benefit.** Await the same command inside "Set up the suite", after the Chromium install, and drop all the concurrency. Measured with oxfmt: preview.ts goes from 1374 to 1294 lines (+20/−100, net −80). Dropping the redundant `--config` flag gives about −88. docs/ci-traces.md:88 loses one phrase.

**What changes (the "almost"):**

1. "Set up the suite" grows from about 0.5 s to about 1.7 s. It still ends at least 38 s before the deploy in all 20 sampled runs, so there is no change on the critical path.
2. The list is never killed when the deploy ends. The only case where that matters is a shard retried after its deploy already finished. Today it kills the list and the suite compiles everything itself. With the change it spends about 1.3 s listing and gets about 1.0 s back, so the net cost is about 0.3 s.
3. A deploy that fails immediately is reported about 1.3 s later, because the wait starts later.
4. The env scrub goes. `--reporter=null` replaces the telemetry and trace reporters, and `--list` runs no global setup and no test body. Nothing in specs/ reads TEST_TELEMETRY_*, FLAKE_RECORD_DIR or CI_TRACE_ENABLED (checked with git grep).
5. The list's output reaches the log through runAsync's inherited stdio. On a failure that means the full error rather than a 20-line tail.
6. The trace span "Warm up the specs' transforms" folds into "Set up the suite".
7. The child now shares preview.ts's process group, so a job cancel reaches it like any other child.

**Guarantees.** None dropped. `runBounded` and `signalGroup` stay: the 30-minute suite bound is untouched.

**Tests pinning today's behaviour.** None. git grep finds warmUp or "warm-up" only in preview.ts, docs/ci-traces.md:88 and a completed task file.
