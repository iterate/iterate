# Public-scanner traffic: Cloudflare edge-gate research

Researched 2026-08-18. Scope: whether common public-internet probes (for example WordPress, exposed-environment, VCS, or PHP-admin paths) can be stopped before they invoke Iterate Workers. This is a research note only; it does not change any Cloudflare configuration.

## Conclusion

Yes. The direct Cloudflare-native control is a **WAF Custom Rule** with a terminating `Block` action, matching a deliberately narrow set of request paths. Custom rules run in `http_request_firewall_custom`; a terminating action stops the request from proceeding to later phases. Cloudflare's Workers metrics documentation explicitly says requests blocked by WAF or other security features do not count as Worker requests. This should remove both Worker invocation cost and Worker-side request/log/trace noise for each matched probe, rather than merely classifying it after the fact.

Sources: [WAF feature interoperability](https://developers.cloudflare.com/waf/feature-interoperability/), [WAF Custom Rules](https://developers.cloudflare.com/waf/custom-rules/), and [Workers metrics and analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics/).

## Scope at Iterate

`envs.ts` places production project ingress at `*.iterate.app` in the production account, and preview ingress at `*.iterate-preview-<n>.app` in the dev/preview account. A zone rule applies to the relevant zone and thus its proxied project hostnames. The production `iterate.app` zone is currently an active Enterprise Website zone (read-only Cloudflare API check on this date).

The live production routes make the scope broader than the `iterate.app` hostname alone:

- The `iterate.app` SaaS zone has a `*/*` Worker route to `os-prd`. Cloudflare documents that this route shape includes Cloudflare-for-SaaS custom hostnames, not only the provider's own hostnames.
- The `iterate.com` zone has `iterate.com/*` and `*.iterate.com/*` routes to `os-prd`.

Consequently, the production policy needs to cover both zones. The `iterate.app` SaaS-zone policy is also the gate for custom-hostname requests routed through that zone.

Source: [Worker as origin for Cloudflare for SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/).

Account-level custom rulesets are available for Enterprise and are evaluated before zone rules, but they apply only to Enterprise zones in one Cloudflare account. They cannot span the separate production and dev/preview accounts. The inspected dev/preview zones are currently Free Website zones, so their deployment must be zone-level unless their plan changes. Therefore the choices are:

1. Install the same zone-level rule in each relevant `iterate.app` and `iterate-preview-<n>.app` zone; or
2. If the relevant zones are Enterprise, deploy an account-level custom ruleset separately in each account, explicitly limiting its deployment to the intended zones.

Sources: [Account-level WAF](https://developers.cloudflare.com/waf/account/), [WAF phases](https://developers.cloudflare.com/waf/reference/phases/), and [Custom Rules availability](https://developers.cloudflare.com/waf/custom-rules/).

## Measured Workers traffic

All figures below come from the connected Workers Observability API for the two explicitly selected accounts. They count distinct `$workers.requestId` values in the `cloudflare-workers` dataset, not raw log lines. The production daily and host-breakdown queries had `sampleInterval` between 1 and 1.0039, so sampling uncertainty is below roughly 0.4% for these figures.

The scanner-shaped classifier matched path segments that were PHP files or well-known probes for WordPress, environment files, Git repositories, CGI, PHPUnit, Actuator, server status, Boa, HNAP, or Autodiscover:

```regex
(?i)(^|/)(?:[^/]*\.php(?:/|$)|wp-admin(?:/|$)|wp-content(?:/|$)|wp-includes(?:/|$)|xmlrpc\.php(?:/|$)|\.git(?:/|$)|\.env(?:[./]|$)|cgi-bin(?:/|$)|vendor/phpunit(?:/|$)|actuator(?:/|$)|server-status(?:/|$)|boaform(?:/|$)|hnap1(?:/|$)|autodiscover(?:/|$))
```

This is a measurement heuristic, not the proposed block expression. It misses other likely probes such as generic GraphQL discovery, while arbitrary project code can intentionally expose a path that happens to match it.

### Production account, `os-prd`

For the seven complete UTC days from 2026-08-11 through 2026-08-17:

| UTC date       | All `os-prd` invocations | Scanner-shaped invocations |     Share |
| -------------- | -----------------------: | -------------------------: | --------: |
| 2026-08-11     |                  310,429 |                     25,523 |      8.2% |
| 2026-08-12     |                  291,542 |                     40,219 |     13.8% |
| 2026-08-13     |                  207,612 |                     32,828 |     15.8% |
| 2026-08-14     |                  193,142 |                     50,176 |     26.0% |
| 2026-08-15     |                  293,355 |                    111,302 |     37.9% |
| 2026-08-16     |                  244,075 |                     94,871 |     38.9% |
| 2026-08-17     |                  266,137 |                     77,397 |     29.1% |
| **Daily mean** |              **258,042** |                 **61,759** | **23.9%** |

Those scanner-shaped invocations generated a mean 123,483 Workers telemetry events per day because the application wide log and Cloudflare invocation event commonly both represented the request.

Across the seven days, the scanner-shaped requests split by host suffix as follows:

| Host group                                | Invocations | Daily mean | Share of scanner-shaped traffic |
| ----------------------------------------- | ----------: | ---------: | ------------------------------: |
| `iterate.com` and subdomains              |     315,926 |     45,132 |                           73.1% |
| `iterate.app` and subdomains              |      56,396 |      8,057 |                           13.0% |
| SaaS/custom hostnames with other suffixes |      59,994 |      8,571 |                           13.9% |

On 2026-08-17, 41,985 of the 77,397 requests were classified by the application as the `project` ingress lane and therefore proceeded into the dynamic-worker serve path; 35,229 were rejected after hostname resolution as `notFound`. Responses were 65,571 HTTP 404s, 11,681 HTTP 200s, 86 without a recorded status, and two HTTP 500s. The 200s are an additional reason to begin with exact observed paths and a logging rollout rather than block the entire measurement regex.

The top paths by distinct invocation on that day were:

| Path                                                | Invocations | Telemetry events |
| --------------------------------------------------- | ----------: | ---------------: |
| `/.git/config`                                      |         997 |            1,990 |
| `/.git/HEAD`                                        |         574 |            1,154 |
| `/wp-content/plugins/hellopress/wp_filemanager.php` |         452 |              912 |
| `/.env`                                             |         443 |              885 |
| `/222.php`                                          |         442 |              884 |
| `/this_is_a_new_hello_world.php`                    |         440 |              880 |
| `/info.php`                                         |         435 |              869 |
| `/admin.php`                                        |         400 |              802 |
| `/wp-login.php`                                     |         386 |              772 |

The Cloudflare invocation-event rows report 356,707 ms of outer `os-prd` CPU for matched requests on 2026-08-17 (mean 4.77 ms, p95 11 ms). This excludes the economic significance of downstream dynamic-worker work and is therefore not a complete cost total.

### Dev/preview account

On 2026-08-17, the matching `os-preview-*` services saw 1,382 scanner-shaped invocations; 1,380 were `notFound` and none were classified as the project lane. Scanner traffic is therefore not the main dev/preview observability problem.

The same query exposed a separate, unexplained volume on that date: `os-preview-4` emitted 5,141,152 telemetry events, `os-preview-3` 3,233,478, `os-preview-7` 2,358,551, and previews 14 and 15 about 1.4 million each. These events were not scanner-path matches and need their own investigation; this note does not classify them as healthy or expected.

### Reproducible query shape

The daily totals used this Workers Observability request, once with only the service filter and once with the scanner-path filter added. `from` and `to` were the exact UTC day boundaries in Unix milliseconds.

```json
{
  "queryId": "daily-scanner",
  "timeframe": { "from": 0, "to": 0 },
  "view": "calculations",
  "chartType": "aggregate",
  "ignoreSeries": true,
  "parameters": {
    "datasets": ["cloudflare-workers"],
    "calculations": [
      {
        "operator": "uniq",
        "key": "$workers.requestId",
        "keyType": "string",
        "alias": "invocations"
      }
    ],
    "filters": [
      {
        "key": "$metadata.service",
        "operation": "eq",
        "type": "string",
        "value": "os-prd"
      },
      {
        "key": "$workers.event.request.path",
        "operation": "regex",
        "type": "string",
        "value": "<scanner regex above>"
      }
    ]
  }
}
```

The host, path, ingress-lane, response-status, and method breakdowns used the same request with one `groupBys` entry for, respectively, `$workers.event.request.headers.host`, `$workers.event.request.path`, `ingress.lane`, `$workers.event.response.status`, or `$workers.event.request.method`.

## Suggested policy shape (not yet a proposed deployment)

Use exact paths and narrow prefixes, normalized with `lower(http.request.uri.path)`. A starter expression shape is:

```
lower(http.request.uri.path) in {
  "/wp-login.php"
  "/wp-admin.php"
  "/xmlrpc.php"
  "/.env"
  "/.git/config"
  "/administrator/index.php"
  "/vendor/phpunit/phpunit/src/util/php/eval-stdin.php"
}
or starts_with(lower(http.request.uri.path), "/wp-admin/")
or starts_with(lower(http.request.uri.path), "/phpmyadmin/")
```

Then use `Block`. This is intentionally a short, evidence-led denylist, not a copied "every scanner path" list. `wildcard` matching is case-insensitive; `matches` (regular expressions) requires Business or Enterprise. Custom lists do not support URI paths, so a path denylist belongs in the rule expression, not a Cloudflare list.

Sources: [Rules language operators](https://developers.cloudflare.com/ruleset-engine/rules-language/operators/), [editing expressions](https://developers.cloudflare.com/ruleset-engine/rules-language/expressions/edit-expressions/), and [custom-list types](https://developers.cloudflare.com/waf/tools/lists/custom-lists/).

## Important compatibility and rollout constraints

Project ingress is deliberately capable of serving arbitrary user code. That means paths that look like an irrelevant framework probe may nevertheless be an intentional project route. Do not globally block any candidate solely because it is familiar scanner traffic.

1. First obtain a path/host/count sample for each target zone and select only paths demonstrated to be unwanted. Preserve the sample and the exact rule expression as the durable explanation for the block.
2. On Enterprise, create the rule as `Log` first and inspect Security Events; otherwise use a deliberately tiny initial block set and monitor the same views. `Log` is Enterprise-only. Security Analytics covers all incoming HTTP traffic; Security Events covers requests actioned or flagged by a security product.
3. Exclude any required certificate-validation or product paths. In particular, Cloudflare warns that security controls affecting `/.well-known/*` can interfere with HTTP domain-control validation.
4. Re-check raw versus transformed paths if Transform Rules are present: WAF normally sees the rewritten URI; use `raw.http.request.uri.path` only when the policy is intentionally against the pre-transform path.
5. Measure the result as a before/after pair: Security Analytics requests for the rule's paths, Security Events blocks by rule/path, and Workers request count/errors. Do not treat a reduced Worker error counter alone as proof.

Sources: [Custom Rules plan limits](https://developers.cloudflare.com/waf/custom-rules/), [Security Analytics](https://developers.cloudflare.com/waf/analytics/security-analytics/), [Security Events](https://developers.cloudflare.com/waf/analytics/security-events/), [HTTP DCV troubleshooting](https://developers.cloudflare.com/ssl/edge-certificates/changing-dcv-method/troubleshooting/), and [rule phase interactions](https://developers.cloudflare.com/waf/troubleshooting/phase-interactions/).

## Adjacent controls, not replacements

- Cloudflare Managed Rules are useful baseline coverage, but run after custom rules and are not a curated deterministic path denylist.
- Rate limiting runs after custom rules; use it for repeated traffic patterns, not known-impossible endpoints that should be rejected immediately.
- Bot Fight Mode is domain-wide and not customizable; Super Bot Fight Mode is configurable on eligible paid plans. Both are broader behavioural controls and carry more compatibility risk for APIs and project applications.

Sources: [Managed Rules](https://developers.cloudflare.com/waf/managed-rules/), [WAF feature interoperability](https://developers.cloudflare.com/waf/feature-interoperability/), [Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/), and [Super Bot Fight Mode on Pro](https://developers.cloudflare.com/bots/plans/pro/).

## Current access and inventory finding

The initially connected Cloudflare API token could read zone metadata but not WAF rulesets. After the Doppler deployment tokens received WAF access on 2026-08-18, read-only inventory confirmed that the production account-level `http_request_firewall_custom` entrypoint does not exist, neither production zone has a zone-level entrypoint for that phase, and the inspected `iterate-preview-19.app` phase is also absent. The production account has no pre-existing custom ruleset with the proposed `iterate-scanner-gate` name. This makes first adoption safe; subsequent Alchemy plans become the drift check for the phase the stack owns.

## Infrastructure-as-code / Alchemy v2

### Recommendation

Use a small, dedicated **edge-gate reconciliation module** with a reviewed policy file; do not add this to the normal Worker deploy or `ensure-resources` scripts. The repository currently has no Alchemy dependency or stack, and its documented deployment model deliberately uses `envs.ts` plus small imperative Cloudflare scripts. Commit `cec967c7dc173afa0bd3d83f66e2092fcc7ba504` removed Alchemy from the repo in July 2026, including its dependency, patches, state store, and roughly 4,000 lines of infrastructure plumbing. Reintroducing a beta IaC framework for one security control would reverse that explicit simplification.

Alchemy v2 is technically capable, but should be reintroduced only as a deliberately isolated edge-gate stack, not as a return to using Alchemy for every Worker and binding. The current published version checked for this follow-up is `alchemy@2.0.0-beta.72`; its Cloudflare provider exports the three resources required here and registers their providers: `Cloudflare.Ruleset.Ruleset`, `Cloudflare.Ruleset.CustomRuleset`, and `Cloudflare.Ruleset.AccountEntrypoint`. The deciding question is ownership: those resources own complete rule arrays/phase entrypoints. If Iterate is willing to make this stack authoritative for the complete account WAF entrypoint, Alchemy gives us a useful plan/state/adoption lifecycle. If unrelated rules must remain independently managed, the narrower direct adapter remains the safer fit.

Sources: Iterate's [current Cloudflare/Doppler deployment model](devops-cloudflare-doppler.md), the local de-Alchemy commit `cec967c7dc173afa0bd3d83f66e2092fcc7ba504`, and Alchemy's primary source: [Cloudflare Ruleset exports](https://github.com/alchemy-run/alchemy/blob/33ce5f4f63c02644b5371e4ce0af383e0ea649b9/packages/alchemy/src/Cloudflare/Ruleset/index.ts), [provider registration](https://github.com/alchemy-run/alchemy/blob/33ce5f4f63c02644b5371e4ce0af383e0ea649b9/packages/alchemy/src/Cloudflare/Providers.ts), and [package version](https://github.com/alchemy-run/alchemy/blob/33ce5f4f63c02644b5371e4ce0af383e0ea649b9/packages/alchemy/package.json).

The public interface should be a small policy module, for example `cloudflare-security-policy.ts`, rather than a hand-written Cloudflare expression scattered through deployment code. It should contain only approved entries such as an exact path or subtree, a short reason, the evidence date/query reference, rollout state (`log` or `block`), and any deliberate host/zone exception. A compiler in `scripts/cloudflare/scanner-gate.ts` validates normalization, duplicates, forbidden broad entries (especially `/.well-known`), and Cloudflare expression-size/rule-count limits, then produces the WAF rules. That gives reviewers one durable answer to “what do we block and why?” while keeping the Cloudflare Rulesets API adapter an implementation detail.

Keep discovered candidates separate from this approved policy. A scheduled, read-only observability job may open a report/PR with new high-volume candidates, but it must never promote them to `Block` automatically: arbitrary project code can intentionally own a scanner-looking path.

### Exact Alchemy shape and lifecycle

For a zone, `Cloudflare.Ruleset.Ruleset` owns a phase entrypoint and accepts a zone, phase, and complete `rules` array. Its normal reconciliation uses Cloudflare's phase `PUT`; rule/name/description edits update in place, a zone or phase change replaces the resource, and destroy writes an empty rules array. For this policy the phase is `http_request_firewall_custom`.

For an Enterprise account-wide deployment, use the pair:

1. `Cloudflare.Ruleset.CustomRuleset` — the account-scoped reusable ruleset (`kind: "custom"`); and
2. `Cloudflare.Ruleset.AccountEntrypoint` — the per-account, per-phase singleton containing an `execute` rule that deploys that custom ruleset, scoped in its expression to the intended zones.

Both account resources require the Enterprise account WAF phase; Alchemy surfaces a non-entitled account as the typed `PhaseNotEntitled` failure. This matches the observed production-versus-dev plan boundary: production can use the account-level pair, whereas today's Free dev/preview zones need a `Cloudflare.Ruleset.Ruleset` instance per target zone.

Sources: [zone Ruleset source and lifecycle](https://github.com/alchemy-run/alchemy/blob/33ce5f4f63c02644b5371e4ce0af383e0ea649b9/packages/alchemy/src/Cloudflare/Ruleset/Ruleset.ts), [account custom-ruleset source and lifecycle](https://github.com/alchemy-run/alchemy/blob/33ce5f4f63c02644b5371e4ce0af383e0ea649b9/packages/alchemy/src/Cloudflare/Ruleset/CustomRuleset.ts), [account-entrypoint source and lifecycle](https://github.com/alchemy-run/alchemy/blob/33ce5f4f63c02644b5371e4ce0af383e0ea649b9/packages/alchemy/src/Cloudflare/Ruleset/AccountEntrypoint.ts), and Alchemy's [live lifecycle tests](https://github.com/alchemy-run/alchemy/blob/33ce5f4f63c02644b5371e4ce0af383e0ea649b9/packages/alchemy/test/Cloudflare/Ruleset/AccountEntrypoint.test.ts).

### Critical ownership constraint

Do **not** apply any implementation until the current custom-rule entrypoints have been read and inventoried. Each of the three Alchemy resources owns the entire rule array of its phase entrypoint; an out-of-band rule in that same phase is overwritten on the next apply. Likewise, deleting the Alchemy stack empties the entrypoint. This is why the recommended direct-API adapter should own only the uniquely named `iterate-scanner-gate` custom ruleset and its uniquely marked `execute` rule, updating those by discovered IDs and preserving every unrelated entrypoint rule.

The deployment tokens now have the corresponding Zone WAF access for per-zone management and Account WAF access for production account-level management. The first inventory found no rules to import in `http_request_firewall_custom`; a later non-empty out-of-band phase must fail review rather than be silently overwritten. Alchemy's primary permission catalog exposes both permission groups.

Source: [Alchemy Ruleset ownership semantics](https://github.com/alchemy-run/alchemy/blob/33ce5f4f63c02644b5371e4ce0af383e0ea649b9/packages/alchemy/src/Cloudflare/Ruleset/Ruleset.ts), [AccountEntrypoint ownership semantics](https://github.com/alchemy-run/alchemy/blob/33ce5f4f63c02644b5371e4ce0af383e0ea649b9/packages/alchemy/src/Cloudflare/Ruleset/AccountEntrypoint.ts), and [Cloudflare API-token permission catalog](https://github.com/alchemy-run/alchemy/blob/33ce5f4f63c02644b5371e4ce0af383e0ea649b9/packages/alchemy/src/Cloudflare/ApiToken/PermissionGroups.ts).

### State and application workflow

No separate state store is required for the recommended adapter. It should discover the owned ruleset by its immutable unique name and the deployment rule by an owned marker, fail if either is ambiguous, and use Cloudflare's returned IDs only for the duration of the reconciliation. The `prd` Doppler configuration supplies the existing account-scoped credentials, and `resolveEnvContext` supplies the repo's existing wrong-account guard and typed `cf`/`cfV4` API seam.

The intended workflow is:

1. A pull request changes the approved policy file. CI compiles it, unit-tests the generated expressions, and runs a read-only `plan` against the production account, without applying.
2. A dedicated protected deployment job runs `apply` after merge: production begins in `log` mode where entitlement permits, is measured, and is promoted to `block` in a subsequent reviewed change. Dev/preview should initially be omitted: its measured scanner volume is small, its zones are Free, and `log` is unavailable there.
3. A scheduled weekly read-only job queries the same Workers/Security datasets, creates a candidate report with counts and representative hosts, and opens a PR or issue for human triage. It never writes Cloudflare configuration.
4. The applying job reads back the owned entrypoint and emits before/after evidence: WAF actions by rule/path plus reduced Worker invocations, CPU, and error/trace noise. Drift is a failed plan/review item, not silently tolerated configuration.

Sources: Iterate's existing [`resolveEnvContext`](../scripts/lib/env-context.ts), Cloudflare's [Rulesets API](https://developers.cloudflare.com/ruleset-engine/rulesets-api/), [Security Analytics](https://developers.cloudflare.com/waf/analytics/security-analytics/), and [Security Events](https://developers.cloudflare.com/waf/analytics/security-events/) documentation. For comparison, Alchemy's state alternatives are documented in its [local state implementation](https://github.com/alchemy-run/alchemy/blob/33ce5f4f63c02644b5371e4ce0af383e0ea649b9/packages/alchemy/src/State/LocalState.ts) and [Cloudflare-backed state implementation](https://github.com/alchemy-run/alchemy/blob/33ce5f4f63c02644b5371e4ce0af383e0ea649b9/packages/alchemy/src/Cloudflare/StateStore/State.ts).

### Verified Alchemy v2 / Effect stack example

The public resources are real, and an Alchemy implementation is small. This is a **runnable resource shape**, subject to supplying the policy-module import, authenticating an Alchemy profile for the production account, and first inventorying every existing rule in the account phase entrypoint. It deliberately uses one custom ruleset and one account phase entrypoint, both owned wholly by the stack.

```ts
// infra/scanner-gate.alchemy.ts
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

// In the actual implementation, import these from the reviewed policy file.
const exactPaths = ["/.env", "/.git/config", "/.git/head", "/wp-login.php", "/xmlrpc.php"] as const;

const scannerExpression = [
  `lower(http.request.uri.path) in {${exactPaths.map((path) => `\"${path}\"`).join(" ")}}`,
  `starts_with(lower(http.request.uri.path), "/wp-admin/")`,
].join(" or ");

export default Alchemy.Stack(
  "iterate-edge-gate",
  {
    providers: Cloudflare.providers(),
    // Persistent IaC state, hosted in the same authenticated Cloudflare account.
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const scannerGate = yield* Cloudflare.Ruleset.CustomRuleset("ScannerGateRules", {
      name: "iterate-scanner-gate",
      phase: "http_request_firewall_custom",
      description: "Reviewed public-internet scanner path policy",
      rules: [
        {
          description: "Block reviewed scanner paths before Workers",
          expression: scannerExpression,
          action: "block",
        },
      ],
    });

    const deployment = yield* Cloudflare.Ruleset.AccountEntrypoint("ScannerGateDeployment", {
      name: "iterate-scanner-gate-deployment",
      phase: "http_request_firewall_custom",
      description: "Executes iterate-scanner-gate in this production account",
      rules: [
        {
          description: "Execute Iterate scanner gate",
          // Account custom-WAF deployment rules must be Enterprise-scoped;
          // also constrain this stack to Iterate's two production zones.
          expression: '(cf.zone.plan eq "ENT" and cf.zone.name in {"iterate.app" "iterate.com"})',
          action: "execute",
          actionParameters: { id: scannerGate.rulesetId },
          enabled: true,
        },
      ],
    });

    return {
      scannerGateRulesetId: scannerGate.rulesetId,
      entrypointRulesetId: deployment.rulesetId,
    };
  }),
);
```

`Effect.gen` is required here because Alchemy resources are Effects and are composed with `yield*`; no additional Effect Layer or runtime service is required beyond `Cloudflare.providers()` and `Cloudflare.state()`. `Cloudflare.state()` is not merely local bookkeeping: the first `plan`, `deploy`, or `dev` bootstraps a Cloudflare Worker/Durable Object state store after confirmation. Bootstrap that state store explicitly in the production account before putting `plan` in a read-only PR job.

Pin both packages: the current `alchemy@2.0.0-beta.72` peer range requires Effect 4, while npm's unqualified `effect` latest is still Effect 3. At the time of verification the compatible release is `effect@4.0.0-rc.110`.

The corresponding commands are:

```sh
pnpm add -D alchemy@2.0.0-beta.72 effect@4.0.0-rc.110

# One-time: configure an Alchemy profile whose token selects Iterate production.
pnpm exec alchemy login --profile iterate-prd --configure

# One-time, before PR plans: create/adopt the Cloudflare-backed state store.
pnpm exec alchemy cloudflare bootstrap --profile iterate-prd

# Read the Cloudflare resources and render the change.
pnpm exec alchemy plan infra/scanner-gate.alchemy.ts --stage prd --profile iterate-prd

# Apply only from the protected deployment workflow.
pnpm exec alchemy deploy infra/scanner-gate.alchemy.ts --stage prd --profile iterate-prd --yes
```

`Cloudflare.providers()` wires Alchemy's profile-aware Cloudflare provider. For CI, configure the profile to use environment credentials; the existing Doppler deployment configuration can then supply `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`. The token needs the Account WAF permission identified above.

This design executes the custom ruleset only for the two named Enterprise production zones. The account entrypoint itself remains a singleton for the whole account, so every other legitimate rule in that entrypoint still has to appear in the same `rules` array. On the Free dev/staging account, use one `Cloudflare.Ruleset.Ruleset` per target zone instead of the Enterprise-only account resources.

There are two non-negotiable ownership consequences:

1. `CustomRuleset` owns all rules within the named custom ruleset. Destroy deletes that custom ruleset.
2. `AccountEntrypoint` owns the entire `http_request_firewall_custom` account entrypoint. Its reconciliation overwrites the full entrypoint rules array; `alchemy destroy` writes that array as `[]` (it does not delete the phase singleton).

Therefore, this stack is a good choice only after importing all legitimate production entrypoint rules into this one stack, or after confirming the entrypoint is exclusively the scanner gate. Production CI should forbid `alchemy destroy` for this stack. If preservation of independently managed entrypoint rules is a hard requirement, use the narrower direct Cloudflare API adapter described above instead; Alchemy's current resource contract cannot own just one entrypoint rule.

Source verification against Alchemy's 2026-08-17 main commit: [CustomRuleset contract/provider](https://github.com/alchemy-run/alchemy/blob/6b73819a02f609e8942b1d9286dc197fbca200ab/packages/alchemy/src/Cloudflare/Ruleset/CustomRuleset.ts), [AccountEntrypoint contract/provider](https://github.com/alchemy-run/alchemy/blob/6b73819a02f609e8942b1d9286dc197fbca200ab/packages/alchemy/src/Cloudflare/Ruleset/AccountEntrypoint.ts), [Cloudflare provider wiring](https://github.com/alchemy-run/alchemy/blob/6b73819a02f609e8942b1d9286dc197fbca200ab/packages/alchemy/src/Cloudflare/Providers.ts), [state-store implementation](https://github.com/alchemy-run/alchemy/blob/6b73819a02f609e8942b1d9286dc197fbca200ab/packages/alchemy/src/Cloudflare/StateStore/State.ts), and [CLI plan/deploy implementation](https://github.com/alchemy-run/alchemy/blob/6b73819a02f609e8942b1d9286dc197fbca200ab/packages/alchemy/src/Cli/commands/deploy.ts).
