import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { eq } from "drizzle-orm";
import { match } from "ts-pattern";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { redirect } from "@tanstack/react-router";
import { useState } from "react";
import * as schema from "../../../../backend/db/schema.ts";
import { isEstateOnboardingRequired } from "../../../../backend/onboarding-utils.ts";
import { useTRPC } from "../../../lib/trpc.ts";
import { Button } from "../../../components/ui/button.tsx";
import { authenticatedServerFn } from "../../../lib/auth-middleware.ts";
import { OnboardingSlackStep } from "./onboarding-slack-step.tsx";
import { OnboardingConfirmOrgStep } from "./onboarding-confirm-org-step.tsx";

const estateOnboardingLoader = authenticatedServerFn
  .inputValidator(z.object({ organizationId: z.string(), estateId: z.string() }))
  .handler(async ({ context, data }) => {
    const { organizationId, estateId } = data;
    const { db } = context.variables;

    const required = await isEstateOnboardingRequired(db, estateId);
    if (!required)
      throw redirect({ to: `/$organizationId/$estateId`, params: { organizationId, estateId } });

    const organization = await db.query.organization.findFirst({
      where: eq(schema.organization.id, organizationId),
    });

    if (!organization) throw notFound();

    return { organization, estateId, organizationId };
  });

export const Route = createFileRoute("/_auth.layout/$organizationId/$estateId/onboarding")({
  component: EstateOnboarding,
  validateSearch: z.object({
    step: z.enum(["confirm_org", "slack", "slack_complete"]).default("confirm_org"),
  }),
  loader: ({ params }) =>
    estateOnboardingLoader({
      data: { organizationId: params.organizationId, estateId: params.estateId },
    }),
  head: () => ({
    meta: [
      { title: "Onboarding - Iterate" },
      { name: "description", content: "Complete your estate onboarding" },
    ],
  }),
});

export default function EstateOnboarding() {
  const { organization, estateId, organizationId } = Route.useLoaderData();
  const trpc = useTRPC();
  const { step: initialStep } = Route.useSearch();
  const [step, setStep] = useState<typeof initialStep>(initialStep);

  const completeOnboardingStep = useMutation(
    trpc.estate.completeUserOnboardingStep.mutationOptions({
      onError: (error) => toast.error(error.message),
    }),
  );
  const navigate = useNavigate();
  const { isLoading } = useRouterState();

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

  if (isFetching || isLoading) return <div>Loading...</div>;

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
                  {
                    onSuccess: () =>
                      navigate({
                        to: `/$organizationId/$estateId`,
                        params: { organizationId, estateId },
                      }),
                  },
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
