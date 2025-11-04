import { useState } from "react";
import { redirect, useLoaderData, useNavigate, useNavigation, useSearchParams } from "react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { eq } from "drizzle-orm";
import { match } from "ts-pattern";
import * as schema from "../../../../backend/db/schema.ts";
import { isEstateOnboardingRequired } from "../../../../backend/onboarding-utils.ts";
import { useTRPC } from "../../../lib/trpc.ts";
import { Button } from "../../../components/ui/button.tsx";
import { ReactRouterServerContext } from "../../../context.ts";
import type { Route } from "./+types/onboarding.ts";
import { OnboardingSlackStep } from "./onboarding-slack-step.tsx";
import { OnboardingConfirmOrgStep } from "./onboarding-confirm-org-step.tsx";

export async function loader({ params, context }: Route.LoaderArgs) {
  const { db } = context.get(ReactRouterServerContext).variables;

  const { estateId, organizationId } = params;
  if (!estateId || !organizationId) throw redirect("/");

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
  const completeOnboardingStep = useMutation(
    trpc.estate.completeUserOnboardingStep.mutationOptions({
      onError: (error) => toast.error(error.message),
    }),
  );
  const navigate = useNavigate();
  const { state } = useNavigation();

  const { isFetching } = useQuery(
    trpc.integrations.list.queryOptions(
      {
        estateId: estateId,
      },
      {
        enabled: step === "slack_complete",
      },
    ),
  );

  if (isFetching || state === "loading") return <div>Loading...</div>;

  return (
    <>
      {/* {!isSlackConnected && (
        <Button asChild>
          <a href={`/${organizationId}/${estateId}/onboarding?step=slack`}>Connect bot to slack</a>
        </Button>
      )} */}
      {match(step)
        .with("slack_complete", () => (
          <>
            <Button
              onClick={() => {
                completeOnboardingStep.mutate(
                  { estateId, step: "slack" },
                  { onSuccess: () => navigate(`/${organizationId}/${estateId}`) },
                );
              }}
            >
              Complete onboarding! 🤗
            </Button>
          </>
        ))
        .with("confirm_org", () => (
          <OnboardingConfirmOrgStep
            organizationId={organizationId}
            organizationName={organization.name}
            onComplete={() => setStep("slack")}
          />
        ))
        .otherwise(() => (
          <OnboardingSlackStep
            organizationId={organizationId}
            estateId={estateId}
            onComplete={() => setStep("slack_complete")}
          />
        ))}
    </>
  );
}
