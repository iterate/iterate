import { useState } from "react";
import { ArrowRight } from "lucide-react";
import { redirect, useLoaderData, useNavigate, useParams, useRouteLoaderData } from "react-router";
import { asc, eq } from "drizzle-orm";
import { useMutation, useSuspenseQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { getDb } from "../../../backend/db/client.ts";
import { estate } from "../../../backend/db/schema.ts";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { Card, CardContent } from "../../components/ui/card.tsx";
import { useTRPC } from "../../lib/trpc.ts";
import type { Route } from "./+types/onboarding.ts";
import type { loader as orgLoader } from "./loader.tsx";

export async function loader({ params }: Route.LoaderArgs) {
  const { organizationId } = params;

  // Parent loader already checked session and organization access
  // We just need to get the first estate for this organization
  if (!organizationId) {
    throw redirect("/");
  }
  const db = getDb();
  const firstEstate = await db.query.estate.findFirst({
    where: eq(estate.organizationId, organizationId),
    orderBy: asc(estate.createdAt),
  });

  if (!firstEstate) {
    throw new Error(`The organization ${organizationId} has no estates, this should never happen.`);
  }
  return {
    organizationId,
    estateId: firstEstate.id,
  };
}

type StepProps = {
  organizationId: string;
  estateId: string;
  goTo: (step: string) => void;
  goBack: () => void;
};

function OrganizationNameStep({ organizationId, goTo }: StepProps) {
  const trpc = useTRPC();
  const loaderData = useRouteLoaderData<typeof orgLoader>("routes/org/loader");
  const orgQuery = trpc.organization.get.queryOptions({ organizationId });
  const { data: organization } = useSuspenseQuery({
    ...orgQuery,
    initialData: loaderData?.organization,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  const [organizationName, setOrganizationName] = useState(() => organization.name);

  const updateOrganization = useMutation(
    trpc.organization.updateName.mutationOptions({
      onSuccess: () => {
        goTo("2");
      },
      onError: (mutationError) => {
        toast.error(mutationError.message);
      },
    }),
  );

  return (
    <form
      className="space-y-8"
      onSubmit={async (event) => {
        event.preventDefault();
        const trimmedName = organizationName.trim();
        if (!trimmedName) {
          toast.error("Organization name is required");
          return;
        }
        await updateOrganization.mutateAsync({ organizationId, name: trimmedName });
      }}
    >
      <div className="space-y-3">
        <p className="text-muted-foreground">Step 1 of 3</p>
        <h2 className="text-2xl font-semibold">What is your organization called?</h2>
      </div>

      <div className="grid gap-8 md:grid-cols-2">
        <div className="text-muted-foreground">
          <p>
            If you're just playing around or planning to use @iterate alone, just leave this as is.
          </p>
        </div>

        <div className="space-y-4">
          <Input
            value={organizationName}
            onChange={(event) => {
              setOrganizationName(event.target.value);
            }}
            disabled={updateOrganization.isPending}
            autoFocus
            onFocus={(event) => {
              event.currentTarget.select();
            }}
          />
        </div>
      </div>
      <div className="flex justify-end pt-4">
        <Button type="submit" disabled={updateOrganization.isPending}>
          {updateOrganization.isPending ? (
            <>
              Confirming
              <ArrowRight className="ml-2 h-4 w-4" />
            </>
          ) : (
            <>
              Confirm
              <ArrowRight className="ml-2 h-4 w-4" />
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

function SlackStep({ organizationId }: StepProps) {
  const handleOpenSlack = () => {
    window.open("slack://open", "_blank", "noopener,noreferrer");
  };

  return (
    <div className="flex justify-center">
      <Card variant="muted" className="w-full max-w-2xl">
        <CardContent className="px-12 py-16">
          <div className="text-center space-y-8">
            <h2 className="text-4xl font-semibold">You're all set!</h2>
            <Button
              size="lg"
              className="h-auto w-full max-w-md px-12 py-6 text-xl"
              onClick={handleOpenSlack}
            >
              <img src="/slack.svg" alt="Slack" className="h-6 w-6 mr-3" />
              Continue in Slack
            </Button>
            <div>
              <Button
                variant="ghost"
                className="text-sm text-muted-foreground hover:text-foreground"
                asChild
              >
                <a href={`/${organizationId}`}>Or go to your dashboard</a>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default function OrganizationOnboarding() {
  const params = useParams<{ organizationId: string; step?: string }>();
  const { organizationId, step: routeStep } = params;
  const { estateId } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  const allowedSteps = ["1", "2"] as const;
  type StepKey = (typeof allowedSteps)[number];
  const isStepKey = (s: string | null): s is StepKey =>
    s !== null && (allowedSteps as readonly string[]).includes(s);
  const currentStep: StepKey = isStepKey(routeStep ?? null) ? (routeStep as StepKey) : "1";

  const navigateToStep = (step: string) => {
    navigate(`/${organizationId}/onboarding/${step}`);
  };

  if (!organizationId) {
    return null;
  }

  const steps = {
    "1": OrganizationNameStep,
    "2": SlackStep,
  } as const;

  const ActiveStep = steps[currentStep] ?? OrganizationNameStep;

  return (
    <>
      <main className="min-h-screen w-full flex justify-center p-8">
        <div className="w-full max-w-4xl py-16">
          <ActiveStep
            organizationId={organizationId}
            estateId={estateId}
            goTo={(s: string) => navigateToStep(s)}
            goBack={() => {
              const prev = String(Math.max(1, Number(currentStep) - 1));
              navigateToStep(prev);
            }}
          />
        </div>
      </main>
    </>
  );
}
