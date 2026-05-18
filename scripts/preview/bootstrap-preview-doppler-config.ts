import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { runCommand } from "../../packages/shared/src/node/run-command.ts";
import {
  ensurePreviewManagedDopplerProjectsExist,
  listPreviewManagedDopplerProjects,
  PREVIEW_DOPPLER_SHARED_PROJECT,
  previewDopplerConfigName,
} from "./preview-doppler-projects.ts";

const BootstrapPreviewDopplerConfigInput = z.object({
  commandEnvironment: z.custom<NodeJS.ProcessEnv>(),
  previewNumber: z.number().int().min(1).max(99),
  repositoryRoot: z.string().min(1),
  sourcePreviewNumber: z.number().int().min(1).max(99).default(2),
});

const DopplerConfigListResponse = z.array(
  z
    .object({
      name: z.string(),
    })
    .passthrough(),
);

const DopplerSecretsDownload = z.record(z.string(), z.string());

export async function bootstrapPreviewDopplerConfig(
  input: z.infer<typeof BootstrapPreviewDopplerConfigInput>,
) {
  const parsed = BootstrapPreviewDopplerConfigInput.parse(input);
  const targetConfig = previewDopplerConfigName(parsed.previewNumber);
  const sourceConfig = previewDopplerConfigName(parsed.sourcePreviewNumber);
  const dopplerProjects = listPreviewManagedDopplerProjects();

  const projectResults = await ensurePreviewManagedDopplerProjectsExist({
    commandEnvironment: parsed.commandEnvironment,
    dopplerProjects,
    repositoryRoot: parsed.repositoryRoot,
  });

  await assertDopplerConfigExistsOnAllProjects({
    commandEnvironment: parsed.commandEnvironment,
    config: sourceConfig,
    dopplerProjects,
    repositoryRoot: parsed.repositoryRoot,
  });

  const configResults: Array<{ dopplerProject: string; action: "created" | "updated" }> = [];

  for (const dopplerProject of dopplerProjects) {
    const hasConfig = await dopplerConfigExists({
      commandEnvironment: parsed.commandEnvironment,
      config: targetConfig,
      dopplerProject,
      repositoryRoot: parsed.repositoryRoot,
    });

    if (!hasConfig) {
      await runDoppler({
        args: [
          "configs",
          "clone",
          sourceConfig,
          "--project",
          dopplerProject,
          "--name",
          targetConfig,
        ],
        commandEnvironment: parsed.commandEnvironment,
        repositoryRoot: parsed.repositoryRoot,
      });
      if (dopplerProject !== PREVIEW_DOPPLER_SHARED_PROJECT) {
        await runDoppler({
          args: [
            "configs",
            "update",
            targetConfig,
            "--project",
            dopplerProject,
            `--inherits=_shared.${targetConfig}`,
            "--yes",
          ],
          commandEnvironment: parsed.commandEnvironment,
          repositoryRoot: parsed.repositoryRoot,
        });
      }
    }

    const secrets = await downloadDopplerSecrets({
      commandEnvironment: parsed.commandEnvironment,
      config: sourceConfig,
      dopplerProject,
      repositoryRoot: parsed.repositoryRoot,
    });
    const rewrittenSecrets = rewritePreviewSecretValues({
      secrets,
      sourcePreviewNumber: parsed.sourcePreviewNumber,
      targetPreviewNumber: parsed.previewNumber,
    });

    await uploadDopplerSecrets({
      commandEnvironment: parsed.commandEnvironment,
      config: targetConfig,
      dopplerProject,
      repositoryRoot: parsed.repositoryRoot,
      secrets: rewrittenSecrets,
    });

    configResults.push({
      dopplerProject,
      action: hasConfig ? "updated" : "created",
    });
  }

  return {
    previewNumber: parsed.previewNumber,
    dopplerConfig: targetConfig,
    dopplerProjects: projectResults,
    configResults,
  };
}

export function rewritePreviewSecretValues(input: {
  secrets: Record<string, string>;
  sourcePreviewNumber: number;
  targetPreviewNumber: number;
}) {
  const sourceToken = String(input.sourcePreviewNumber);
  const targetToken = String(input.targetPreviewNumber);
  const rewritten: Record<string, string> = {};

  for (const [key, value] of Object.entries(input.secrets)) {
    if (key === "DOPPLER_CONFIG" || key === "DOPPLER_ENVIRONMENT" || key === "DOPPLER_PROJECT") {
      continue;
    }
    rewritten[key] = value
      .replaceAll(`iterate-preview-${sourceToken}`, `iterate-preview-${targetToken}`)
      .replaceAll(`preview_${sourceToken}`, `preview_${targetToken}`)
      .replaceAll(`preview-${sourceToken}`, `preview-${targetToken}`);
  }

  return rewritten;
}

async function assertDopplerConfigExistsOnAllProjects(input: {
  commandEnvironment: NodeJS.ProcessEnv;
  config: string;
  dopplerProjects: string[];
  repositoryRoot: string;
}) {
  const missingProjects: string[] = [];

  for (const dopplerProject of input.dopplerProjects) {
    const hasConfig = await dopplerConfigExists({
      commandEnvironment: input.commandEnvironment,
      config: input.config,
      dopplerProject,
      repositoryRoot: input.repositoryRoot,
    });
    if (!hasConfig) {
      missingProjects.push(dopplerProject);
    }
  }

  if (missingProjects.length > 0) {
    throw new Error(
      `Source Doppler config ${input.config} is missing on: ${missingProjects.join(", ")}. Bootstrap preview_${input.config.split("_")[1]} on those projects first.`,
    );
  }
}

async function dopplerConfigExists(input: {
  commandEnvironment: NodeJS.ProcessEnv;
  config: string;
  dopplerProject: string;
  repositoryRoot: string;
}) {
  const configs = await listDopplerConfigs(input);
  return configs.some((config) => config.name === input.config);
}

async function listDopplerConfigs(input: {
  commandEnvironment: NodeJS.ProcessEnv;
  dopplerProject: string;
  repositoryRoot: string;
}) {
  const result = await runDoppler({
    args: ["configs", "--project", input.dopplerProject, "--json"],
    commandEnvironment: input.commandEnvironment,
    repositoryRoot: input.repositoryRoot,
  });
  return DopplerConfigListResponse.parse(JSON.parse(result.stdout));
}

async function downloadDopplerSecrets(input: {
  commandEnvironment: NodeJS.ProcessEnv;
  config: string;
  dopplerProject: string;
  repositoryRoot: string;
}) {
  const result = await runDoppler({
    args: [
      "secrets",
      "download",
      "--project",
      input.dopplerProject,
      "--config",
      input.config,
      "--format",
      "json",
      "--no-file",
    ],
    commandEnvironment: input.commandEnvironment,
    repositoryRoot: input.repositoryRoot,
  });
  return DopplerSecretsDownload.parse(JSON.parse(result.stdout));
}

async function uploadDopplerSecrets(input: {
  commandEnvironment: NodeJS.ProcessEnv;
  config: string;
  dopplerProject: string;
  repositoryRoot: string;
  secrets: Record<string, string>;
}) {
  const directory = await mkdtemp(join(tmpdir(), "preview-doppler-secrets-"));
  const filePath = join(directory, "secrets.json");
  await writeFile(filePath, JSON.stringify(input.secrets, null, 2));

  try {
    await runDoppler({
      args: [
        "secrets",
        "upload",
        filePath,
        "--project",
        input.dopplerProject,
        "--config",
        input.config,
      ],
      commandEnvironment: input.commandEnvironment,
      repositoryRoot: input.repositoryRoot,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runDoppler(input: {
  args: string[];
  commandEnvironment: NodeJS.ProcessEnv;
  repositoryRoot: string;
}) {
  const result = await runCommand({
    command: "doppler",
    args: input.args,
    echoOutput: true,
    environment: input.commandEnvironment,
    workingDirectory: input.repositoryRoot,
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `doppler ${input.args.join(" ")} failed:\n${result.stderr}\n${result.stdout}`.trim(),
    );
  }
  return result;
}

const isCli = process.argv[1]?.endsWith("bootstrap-preview-doppler-config.ts") ?? false;
if (isCli) {
  const previewNumber = Number.parseInt(process.argv[2] ?? "", 10);
  if (!Number.isInteger(previewNumber)) {
    throw new Error(
      "Usage: pnpm tsx scripts/preview/bootstrap-preview-doppler-config.ts <preview-number>",
    );
  }

  const summary = await bootstrapPreviewDopplerConfig({
    commandEnvironment: process.env,
    previewNumber,
    repositoryRoot: process.cwd(),
  });
  console.log(JSON.stringify(summary, null, 2));
}
