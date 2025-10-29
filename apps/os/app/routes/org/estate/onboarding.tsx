import { useEffect, useState } from "react";
import { redirect, useLoaderData, useNavigate, useNavigation, useSearchParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
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
  const [searchParams] = useSearchParams();
  const initialStep = searchParams.get("step") as
    | "confirm_org"
    | "slack"
    | "slack_complete"
    | undefined;

  const [step, setStep] = useState<"confirm_org" | "slack" | "slack_complete">(
    initialStep || "confirm_org",
  );
  const completeOnboarding = useMutation(
    trpc.estate.completeUserOnboardingStep.mutationOptions({
      onError: (error) => toast.error(error.message),
    }),
  );
  const navigate = useNavigate();
  const { state } = useNavigation();

  const { data, isFetching } = useQuery(
    trpc.integrations.list.queryOptions(
      {
        estateId: estateId,
      },
      {
        enabled: step === "slack_complete",
      },
    ),
  );

  // Filter out Slack connector for trial estates since they're using Slack Connect
  const isSlackConnected =
    data?.oauthIntegrations?.some(
      (integration) => integration.id === "slack-bot" && integration.isConnected,
    ) ?? false;

  useEffect(() => {
    if (isFetching || state === "loading") return;
    if (!isSlackConnected) {
      navigate(`/${organizationId}/${estateId}/onboarding?step=slack`);
      return;
    }
    if (step === "slack_complete") {
      completeOnboarding.mutate(
        { estateId, step: "slack" },
        { onSuccess: () => navigate(`/${organizationId}/${estateId}`) },
      );
    }
  }, [
    initialStep,
    isFetching,
    isSlackConnected,
    estateId,
    organizationId,
    navigate,
    completeOnboarding,
    step,
    state,
  ]);

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
