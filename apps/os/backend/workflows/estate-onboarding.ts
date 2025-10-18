import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workflows";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import * as schema from "../db/schema.ts";
import type { CloudflareEnv } from "../../env.ts";
import { logger } from "../tag-logger.ts";
import { createStripeCustomerAndSubscriptionForOrganization } from "../integrations/stripe/stripe.ts";
import { getOrCreateAgentStubByName } from "../agent/agents/stub-getters.ts";
import type {
  EstateOnboardingData,
  EstateOnboardingState,
  EstateOnboardingStep,
  EstateOnboardingStepStatus,
} from "../../types/estate-onboarding.ts";

interface EstateOnboardingWorkflowParams {
  onboardingId: string;
  organizationId: string;
  estateId: string;
  ownerUserId: string;
  onboardingAgentName: string;
}

const STEP_STRIPE_CUSTOMER = "stripe_customer" as const;
const STEP_ONBOARDING_AGENT = "onboarding_agent" as const;

type StepName = typeof STEP_STRIPE_CUSTOMER | typeof STEP_ONBOARDING_AGENT;

function computeOverallState(steps: EstateOnboardingStep[]): EstateOnboardingState {
  if (steps.some((step) => step.status === "error")) {
    return "error";
  }

  if (steps.length === 0) {
    return "pending";
  }

  if (steps.every((step) => step.status === "completed")) {
    return "completed";
  }

  return "in_progress";
}

async function setOnboardingState(onboardingId: string, state: EstateOnboardingState) {
  const db = getDb();
  await db
    .update(schema.estateOnboarding)
    .set({ state })
    .where(eq(schema.estateOnboarding.id, onboardingId));
}

async function updateStepStatus(
  onboardingId: string,
  stepName: StepName,
  status: EstateOnboardingStepStatus,
  detail?: string,
) {
  const db = getDb();
  const record = await db.query.estateOnboarding.findFirst({
    where: eq(schema.estateOnboarding.id, onboardingId),
  });

  if (!record) {
    throw new Error(`Estate onboarding record ${onboardingId} not found`);
  }

  const existingData: EstateOnboardingData = record.data ?? { steps: [] };
  const steps: EstateOnboardingStep[] = existingData.steps ? [...existingData.steps] : [];
  const now = new Date().toISOString();
  const index = steps.findIndex((step) => step.name === stepName);

  if (index >= 0) {
    const current = steps[index];
    steps[index] = {
      ...current,
      status,
      detail: detail ?? current.detail,
      startedAt: current.startedAt ?? (status !== "pending" ? now : undefined),
      completedAt:
        status === "completed" || status === "error"
          ? now
          : current.completedAt,
    };
  } else {
    steps.push({
      name: stepName,
      status,
      detail,
      startedAt: status === "in_progress" || status === "completed" || status === "error" ? now : undefined,
      completedAt: status === "completed" || status === "error" ? now : undefined,
    });
  }

  const data: EstateOnboardingData = {
    ...existingData,
    steps,
  };

  await db
    .update(schema.estateOnboarding)
    .set({
      data,
      state: computeOverallState(steps),
    })
    .where(eq(schema.estateOnboarding.id, onboardingId));
}

export class EstateOnboardingWorkflow extends WorkflowEntrypoint<
  CloudflareEnv,
  EstateOnboardingWorkflowParams
> {
  async run(event: WorkflowEvent<EstateOnboardingWorkflowParams>, step: WorkflowStep) {
    const payload = event.payload;

    if (!payload) {
      throw new Error("Estate onboarding workflow triggered without payload");
    }

    const { onboardingId, organizationId, estateId, ownerUserId, onboardingAgentName } = payload;

    await step.do("mark onboarding started", async () => {
      await setOnboardingState(onboardingId, "in_progress");
    });

    await step.do("create stripe customer", async () => {
      await updateStepStatus(onboardingId, STEP_STRIPE_CUSTOMER, "in_progress");
      try {
        const db = getDb();
        const organization = await db.query.organization.findFirst({
          where: eq(schema.organization.id, organizationId),
        });
        const user = await db.query.user.findFirst({
          where: eq(schema.user.id, ownerUserId),
        });

        if (!organization) {
          throw new Error(`Organization ${organizationId} not found for onboarding workflow`);
        }

        if (!user) {
          throw new Error(`User ${ownerUserId} not found for onboarding workflow`);
        }

        await createStripeCustomerAndSubscriptionForOrganization(db, organization, user);
        await updateStepStatus(onboardingId, STEP_STRIPE_CUSTOMER, "completed");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to create stripe customer during onboarding for estate ${estateId}: ${message}`, error);
        await updateStepStatus(onboardingId, STEP_STRIPE_CUSTOMER, "error", message);
        throw error;
      }
    });

    await step.do("warm onboarding agent", async () => {
      await updateStepStatus(onboardingId, STEP_ONBOARDING_AGENT, "in_progress");
      try {
        const db = getDb();
        const onboardingAgent = await getOrCreateAgentStubByName("OnboardingAgent", {
          db,
          estateId,
          agentInstanceName: onboardingAgentName,
          reason: "Provisioned via estate onboarding workflow",
        });
        await onboardingAgent.doNothing();
        await updateStepStatus(onboardingId, STEP_ONBOARDING_AGENT, "completed");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to warm onboarding agent for estate ${estateId}: ${message}`, error);
        await updateStepStatus(onboardingId, STEP_ONBOARDING_AGENT, "error", message);
        throw error;
      }
    });

    await step.do("mark onboarding completed", async () => {
      await setOnboardingState(onboardingId, "completed");
    });

    return { status: "completed" };
  }
}
