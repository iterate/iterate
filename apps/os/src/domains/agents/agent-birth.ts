import { childAgentParentPath } from "../../lib/agent-paths.ts";
import { capabilityHostBirthEvents } from "../capability-host/capability-host-birth.ts";
import { DurableObjectNameCodec } from "../durable-object-names.ts";
import { EmailAgentProcessorContract } from "../email/email-agent-processor-contract.ts";
import { isEmailAgentPath } from "../email/utils.ts";
import { SlackAgentProcessorContract } from "../integrations/slack-agent-processor-contract.ts";
import { TelegramAgentProcessorContract } from "../integrations/telegram-agent-processor-contract.ts";
import {
  slackConnectionFromAgentPath,
  telegramConnectionFromAgentPath,
} from "../integrations/utils.ts";
import { githubAgentSubscriptionConfiguredEvent } from "../repos/github-agent-mechanics.ts";
import { isGithubAgentPath } from "../repos/github-agent-utils.ts";
import { buildDurableObjectProcessorSubscriptionConfiguredEvent } from "../streams/utils.ts";
import { AgentProcessorContract } from "./agent-processor-contract.ts";
import { normalizeAgentPath } from "./utils.ts";

/**
 * The complete durable mechanics certificate for one agent stream.
 *
 * Every API that can materialize an agent prepends this idempotent batch to
 * its own first append. The root project processor also applies the same
 * batch when it observes a raw `/agents/**` stream birth, so low-level stream
 * appends eventually acquire mechanics without making that asynchronous
 * reactor a prerequisite for the higher-level agent APIs.
 */
export function agentBirthEvents(input: { agentPath: string; projectId: string }) {
  const agentPath = normalizeAgentPath(input.agentPath);
  const durableObjectName = DurableObjectNameCodec.stringify({
    projectId: input.projectId,
    path: agentPath,
  });
  const subscription = (processorSlug: string) =>
    buildDurableObjectProcessorSubscriptionConfiguredEvent({
      durableObjectName,
      idempotencyKey: `stream/subscription-configured:${durableObjectName}#${processorSlug}`,
      processor: ["agents", ["get", agentPath], "processor"],
      processorSlug,
    });

  // Routed leaves are first-class agents whose route-shaped namespace is not
  // an ancestry chain. Only a real child agent inherits its parent agent and
  // only routed leaves (never their children) receive a transcriber.
  const parentAgentPath = childAgentParentPath(agentPath);
  const isChildAgent = parentAgentPath !== null;
  const isSlack = !isChildAgent && slackConnectionFromAgentPath(agentPath) !== null;
  const isTelegram = !isChildAgent && telegramConnectionFromAgentPath(agentPath) !== null;

  return [
    ...capabilityHostBirthEvents({
      ancestorPath: parentAgentPath ?? "/",
      path: agentPath,
      projectId: input.projectId,
    }),
    subscription(AgentProcessorContract.slug),
    ...(isSlack ? [subscription(SlackAgentProcessorContract.slug)] : []),
    ...(isTelegram ? [subscription(TelegramAgentProcessorContract.slug)] : []),
    ...(!isChildAgent && isEmailAgentPath(agentPath)
      ? [subscription(EmailAgentProcessorContract.slug)]
      : []),
    ...(!isChildAgent && isGithubAgentPath(agentPath)
      ? [
          githubAgentSubscriptionConfiguredEvent({
            agentPath,
            projectId: input.projectId,
          }),
        ]
      : []),
  ];
}
