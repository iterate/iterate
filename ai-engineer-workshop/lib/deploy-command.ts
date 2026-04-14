import * as prompts from "@clack/prompts";
import { z } from "zod";
import type { DeployProcessorResult } from "./deploy-processor.ts";
import { deployProcessor } from "./deploy-processor.ts";

export const DeployCommandInput = z.object({
  file: z.string().trim().min(1).describe("Path to a module that exports a processor"),
  streamPath: z.string().trim().min(1).describe("Stream path to configure, e.g. /jonas/agent"),
  eventJson: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional JSON event to append after the processor is configured"),
  baseUrl: z
    .string()
    .trim()
    .url()
    .optional()
    .describe("Events base URL, defaults to BASE_URL or https://events.iterate.com"),
  projectSlug: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional x-iterate-project header value"),
  slug: z.string().trim().min(1).optional().describe("Optional dynamic worker slug override"),
  processorExportName: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Named export to use when the module exports more than one processor"),
  outboundGateway: z
    .boolean()
    .default(true)
    .describe("Route outbound fetch through DynamicWorkerEgressGateway"),
  nodejsCompat: z
    .boolean()
    .default(true)
    .describe("Enable Cloudflare Workers nodejs_compat for node:* builtins"),
});

export type DeployCommandInput = z.infer<typeof DeployCommandInput>;

export function parseDeployCommandArgs(rawArgs: string[]) {
  const args = rawArgs.slice();
  const parsed: Partial<DeployCommandInput> = {};

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];

    switch (arg) {
      case "-h":
      case "--help":
        return { help: true, input: parsed };
      case "--file":
        parsed.file = requireOptionValue(args, ++index, arg);
        break;
      case "--stream-path":
      case "--streamPath":
        parsed.streamPath = requireOptionValue(args, ++index, arg);
        break;
      case "--event-json":
      case "--eventJson":
        parsed.eventJson = requireOptionValue(args, ++index, arg);
        break;
      case "--base-url":
      case "--baseUrl":
        parsed.baseUrl = requireOptionValue(args, ++index, arg);
        break;
      case "--project-slug":
      case "--projectSlug":
        parsed.projectSlug = requireOptionValue(args, ++index, arg);
        break;
      case "--slug":
        parsed.slug = requireOptionValue(args, ++index, arg);
        break;
      case "--processor-export-name":
      case "--processorExportName":
        parsed.processorExportName = requireOptionValue(args, ++index, arg);
        break;
      case "--outbound-gateway":
      case "--outboundGateway":
        parsed.outboundGateway = parseBooleanFlag(requireOptionValue(args, ++index, arg), arg);
        break;
      case "--no-outbound-gateway":
      case "--no-outboundGateway":
        parsed.outboundGateway = false;
        break;
      case "--nodejs-compat":
      case "--nodejsCompat":
        parsed.nodejsCompat = parseBooleanFlag(requireOptionValue(args, ++index, arg), arg);
        break;
      case "--no-nodejs-compat":
      case "--no-nodejsCompat":
        parsed.nodejsCompat = false;
        break;
      default:
        throw new Error(`Unknown deploy argument: ${arg}`);
    }
  }

  return { help: false, input: parsed };
}

export function getDeployCommandHelp() {
  return [
    "Options:",
    "  --file <path>                              Path to a module that exports a processor",
    "  --stream-path <path>                       Stream path to configure, e.g. /jonas/agent",
    "  --event-json <json>                        Optional JSON seed event to append",
    "  --base-url <url>                           Events base URL",
    "  --project-slug <slug>                      Optional x-iterate-project header value",
    "  --slug <slug>                              Override the dynamic worker slug",
    "  --processor-export-name <name>             Use a named export when the module exports multiple processors",
    "  --outbound-gateway <true|false>            Enable or disable DynamicWorkerEgressGateway",
    "  --nodejs-compat <true|false>               Enable or disable nodejs_compat",
    "  --no-outbound-gateway                      Disable DynamicWorkerEgressGateway",
    "  --no-nodejs-compat                         Disable nodejs_compat",
    "  -h, --help                                 Show this help",
    "",
    "Notes:",
    "  - If `--file` or `--stream-path` is omitted, the CLI will prompt for it.",
  ].join("\n");
}

export async function promptForDeployCommandInput(input: Partial<DeployCommandInput>) {
  return DeployCommandInput.parse({
    ...input,
    file:
      input.file ?? (await promptRequiredText("Processor file", "Path to the processor module")),
    streamPath:
      input.streamPath ?? (await promptRequiredText("Stream path", "Stream path to configure")),
  });
}

export async function runDeployCommand(input: DeployCommandInput) {
  const result = await deployProcessor({
    ...input,
    compatibilityFlags: input.nodejsCompat ? ["nodejs_compat"] : undefined,
  });

  return summarizeDeployResult(result);
}

export function summarizeDeployResult(result: DeployProcessorResult) {
  return {
    baseUrl: result.baseUrl,
    configuredEventType: result.configuredEvent.type,
    file: result.file,
    outboundGateway: result.outboundGateway,
    processorExportName: result.processorExportName,
    processorSlug: result.processorSlug,
    projectSlug: result.projectSlug,
    seedEventType: result.seedEvent?.type,
    streamPath: result.streamPath,
  };
}

function requireOptionValue(args: string[], index: number, flagName: string) {
  const value = args[index];
  if (value == null) {
    throw new Error(`Missing value for ${flagName}`);
  }
  return value;
}

function parseBooleanFlag(value: string, flagName: string) {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  throw new Error(`${flagName} must be "true" or "false"`);
}

async function promptRequiredText(title: string, placeholder: string) {
  const value = await prompts.text({
    message: title,
    placeholder,
    validate(raw) {
      return raw != null && raw.trim().length > 0 ? undefined : `${title} is required`;
    },
  });

  if (prompts.isCancel(value)) {
    process.exit(0);
  }

  return value as string;
}
