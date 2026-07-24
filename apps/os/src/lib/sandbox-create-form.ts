import { z } from "zod";
import {
  DEFAULT_SANDBOX_INSTANCE_TYPE,
  SandboxInstanceType,
} from "~/domains/sandboxes/instance-types.ts";
import {
  assertValidSleepAfter,
  sandboxPathFor,
  type SandboxCreateInput,
} from "~/domains/sandboxes/utils.ts";

export const DEFAULT_SANDBOX_SLEEP_AFTER = "10m";

export const SandboxCreateFormSchema = z
  .object({
    name: z.string().trim().min(1, "Sandbox name is required"),
    instanceType: SandboxInstanceType,
    sleepAfter: z.string().trim(),
    keepAlive: z.boolean(),
  })
  .superRefine((value, context) => {
    try {
      sandboxPathFor(value.name);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["name"],
        message: "Use a single URL-safe path segment without slashes or spaces.",
      });
    }
    if (!value.keepAlive) {
      try {
        assertValidSleepAfter(value.sleepAfter);
      } catch {
        context.addIssue({
          code: "custom",
          path: ["sleepAfter"],
          message: 'Use a positive number of seconds or a duration such as "30s", "5m", or "1h".',
        });
      }
    }
  });

export type SandboxCreateFormValues = z.input<typeof SandboxCreateFormSchema>;

export const DEFAULT_SANDBOX_CREATE_FORM_VALUES: SandboxCreateFormValues = {
  name: "",
  instanceType: DEFAULT_SANDBOX_INSTANCE_TYPE,
  sleepAfter: DEFAULT_SANDBOX_SLEEP_AFTER,
  keepAlive: false,
};

export function shouldApplySandboxSheetOpenChange(
  nextOpen: boolean,
  createPending: boolean,
): boolean {
  return nextOpen || !createPending;
}

export function parseSandboxCreateForm(input: SandboxCreateFormValues): {
  input: SandboxCreateInput;
  path: string;
} {
  const parsed = SandboxCreateFormSchema.parse(input);
  const path = sandboxPathFor(parsed.name);
  if (parsed.keepAlive) {
    return {
      path,
      input: {
        instanceType: parsed.instanceType,
        keepAlive: true,
      },
    };
  }
  return {
    path,
    input: {
      instanceType: parsed.instanceType,
      sleepAfter: parsed.sleepAfter,
    },
  };
}
