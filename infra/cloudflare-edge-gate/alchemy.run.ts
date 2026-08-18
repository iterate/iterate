import * as Alchemy from "alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import { compileProductionDeploymentExpression, compileScannerGateRule } from "./compiler.ts";
import { scannerPathPolicy } from "./policy.ts";
import { resolveEdgeGateTarget } from "./target.ts";

const phase = "http_request_firewall_custom";
const scannerGateRule = compileScannerGateRule(scannerPathPolicy);

export default Alchemy.Stack(
  "iterate-cloudflare-edge-gate",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const target = resolveEdgeGateTarget({
      envName: process.env.EDGE_GATE_ENV,
      cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    });

    if (target.kind === "production") {
      const scannerRuleset = yield* Cloudflare.Ruleset.CustomRuleset("ScannerRuleset", {
        name: "iterate-scanner-gate",
        phase,
        description: "Reviewed public-internet scanner paths blocked before Iterate Workers",
        rules: [scannerGateRule],
      });
      const deployment = yield* Cloudflare.Ruleset.AccountEntrypoint("ScannerRulesetDeployment", {
        name: "iterate-scanner-gate-deployment",
        phase,
        description: "Deploy the Iterate scanner gate to the production ingress zones",
        rules: [
          {
            action: "execute",
            actionParameters: { id: scannerRuleset.rulesetId },
            description: "Execute the Iterate scanner gate on production ingress zones",
            enabled: true,
            expression: compileProductionDeploymentExpression(target.zoneNames),
          },
        ],
      });

      return {
        target: target.envName,
        scannerRulesetId: scannerRuleset.rulesetId,
        deploymentRulesetId: deployment.rulesetId,
      };
    }

    const zone = yield* Cloudflare.Zone.Zone("PreviewIngressZone", {
      name: target.zoneName,
    }).pipe(adopt(true));
    const ruleset = yield* Cloudflare.Ruleset.Ruleset("PreviewScannerRuleset", {
      zone,
      phase,
      name: "iterate-scanner-gate",
      description: "Reviewed public-internet scanner paths blocked before Iterate Workers",
      rules: [scannerGateRule],
    });

    return {
      target: target.envName,
      scannerRulesetId: ruleset.rulesetId,
      deploymentRulesetId: undefined,
    };
  }),
);
