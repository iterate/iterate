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
import { isInstallationOnboardingRequired } from "../../../../backend/onboarding-utils.ts";
import { useTRPC } from "../../../lib/trpc.ts";
import { Button } from "../../../components/ui/button.tsx";
import { authenticatedServerFn } from "../../../lib/auth-middleware.ts";
import { OnboardingSlackStep } from "./onboarding-slack-step.tsx";
import { OnboardingConfirmOrgStep } from "./onboarding-confirm-org-step.tsx";

const installationOnboardingLoader = authenticatedServerFn
  .inputValidator(z.object({ organizationId: z.string(), installationId: z.string() }))
  .handler(async ({ context, data }) => {
    const { organizationId, installationId } = data;
    const { db } = context.variables;

    const required = await isInstallationOnboardingRequired(db, installationId);
    if (!required)
      throw redirect({
        to: `/$organizationId/$installationId`,
        params: { organizationId, installationId },
      });

    const organization = await db.query.organization.findFirst({
      where: eq(schema.organization.id, organizationId),
    });

    if (!organization) throw notFound();

    return { organization, installationId, organizationId };
  });

export const Route = createFileRoute("/_auth.layout/$organizationId/$installationId/onboarding")({
  component: InstallationOnboarding,
  validateSearch: z.object({
    step: z.enum(["confirm_org", "slack", "slack_complete"]).default("confirm_org"),
  }),
  loader: ({ params }) =>
    installationOnboardingLoader({
      data: { organizationId: params.organizationId, installationId: params.installationId },
    }),
  head: () => ({
    meta: [
      { title: "Onboarding - Iterate" },
      { name: "description", content: "Complete your installation onboarding" },
    ],
  }),
});

export default function InstallationOnboarding() {
  const { organization, installationId, organizationId } = Route.useLoaderData();
  const trpc = useTRPC();
  const { step: initialStep } = Route.useSearch();
  const [step, setStep] = useState<typeof initialStep>(initialStep);

  const completeOnboardingStep = useMutation(
    trpc.installation.completeUserOnboardingStep.mutationOptions({
      onError: (error) => toast.error(error.message),
    }),
  );
  const navigate = useNavigate();
  const { isLoading } = useRouterState();

  const { isFetching } = useQuery(
    trpc.integrations.list.queryOptions(
      {
        installationId: installationId,
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
          <a href={`/${organizationId}/${installationId}/onboarding?step=slack`}>Connect bot to slack</a>
        </Button>
      )} */}
      {match(step)
        .with("slack_complete", () => (
          <>
            <Button
              onClick={() => {
                completeOnboardingStep.mutate(
                  { installationId, step: "slack" },
                  {
                    onSuccess: () =>
                      navigate({
                        to: `/$organizationId/$installationId`,
                        params: { organizationId, installationId },
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
            installationId={installationId}
            onComplete={() => setStep("slack_complete")}
          />
        ))}
    </>
  );
}
