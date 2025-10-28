import { useState } from "react";
import { redirect, useLoaderData } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { eq } from "drizzle-orm";
import { getDb } from "../../../../backend/db/client.ts";
import * as schema from "../../../../backend/db/schema.ts";
import { isEstateOnboardingRequired } from "../../../../backend/onboarding-utils.ts";
import { useTRPC } from "../../../lib/trpc.ts";
import { OnboardingSlackStep } from "./onboarding-slack-step.tsx";
import { OnboardingConfirmOrgStep } from "./onboarding-confirm-org-step.tsx";

export async function loader({
  params,
}: {
  params: { organizationId?: string; estateId?: string };
}) {
  const { estateId, organizationId } = params;
  if (!estateId || !organizationId) throw redirect("/");

  const db = getDb();
  const required = await isEstateOnboardingRequired(db, estateId);
  if (!required) throw redirect(`/${organizationId}/${estateId}`);

  const organization = await db.query.organization.findFirst({
    where: eq(schema.organization.id, organizationId),
  });
  if (!organization) throw new Error("Organization not found");

  return { organization, estateId, organizationId } as const;
}

// No other user steps for now

export default function EstateOnboarding() {
  const { organization, estateId, organizationId } = useLoaderData<typeof loader>();
  const trpc = useTRPC();
  const [step, setStep] = useState<"confirm_org" | "slack">("confirm_org");

  const completeOnboarding = useMutation(
    trpc.estate.completeUserOnboardingStep.mutationOptions({
      onError: (error) => toast.error(error.message),
    }),
  );

  return (
    <>
      {step === "confirm_org" ? (
        <OnboardingConfirmOrgStep
          organizationId={organizationId}
          organizationName={organization.name}
          onComplete={() => setStep("slack")}
        />
      ) : (
        <OnboardingSlackStep
          organizationId={organizationId}
          estateId={estateId}
          onComplete={() => completeOnboarding.mutate({ estateId, step: "slack" })}
        />
      )}
    </>
  );
}
