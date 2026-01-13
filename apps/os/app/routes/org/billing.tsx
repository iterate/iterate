import { Suspense, useEffect } from "react";
import { createFileRoute, useParams, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery, useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { CreditCard, ExternalLink } from "lucide-react";
import { z } from "zod/v4";
import { trpc, trpcClient } from "../../lib/trpc.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.tsx";
import { Badge } from "../../components/ui/badge.tsx";
import { Spinner } from "../../components/ui/spinner.tsx";
import { HeaderActions } from "../../components/header-actions.tsx";

const Search = z.object({
  success: z.coerce.string().optional(),
  canceled: z.coerce.string().optional(),
});

export const Route = createFileRoute("/_auth/orgs/$organizationSlug/billing")({
  component: BillingPage,
  validateSearch: Search,
});

function BillingPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center p-8">
          <Spinner />
        </div>
      }
    >
      <BillingContent />
    </Suspense>
  );
}

function BillingContent() {
  const params = useParams({ from: "/_auth/orgs/$organizationSlug/billing" });
  const search = useSearch({ from: "/_auth/orgs/$organizationSlug/billing" });

  useEffect(() => {
    if (search.success === "true") {
      toast.success("Subscription activated successfully!");
    }
  }, [search.success]);

  const { data: billingAccount } = useSuspenseQuery(
    trpc.billing.getBillingAccount.queryOptions({
      organizationSlug: params.organizationSlug,
    }),
  );

  const createCheckout = useMutation({
    mutationFn: () => {
      const baseUrl = window.location.origin;
      const billingPath = `/orgs/${params.organizationSlug}/billing`;
      return trpcClient.billing.createCheckoutSession.mutate({
        organizationSlug: params.organizationSlug,
        successUrl: `${baseUrl}${billingPath}?success=true`,
        cancelUrl: `${baseUrl}${billingPath}?canceled=true`,
      });
    },
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: (error) => {
      toast.error("Failed to create checkout session: " + error.message);
    },
  });

  const createPortal = useMutation({
    mutationFn: () =>
      trpcClient.billing.createPortalSession.mutate({
        organizationSlug: params.organizationSlug,
      }),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
    onError: (error) => {
      toast.error("Failed to open billing portal: " + error.message);
    },
  });

  const subscriptionStatus = billingAccount?.subscriptionStatus;
  const hasActiveSubscription =
    subscriptionStatus === "active" || subscriptionStatus === "trialing";
  const isPastDue = subscriptionStatus === "past_due";
  const isPaused = subscriptionStatus === "paused";
  const isCanceled = subscriptionStatus === "canceled";
  const isIncomplete =
    subscriptionStatus === "incomplete" || subscriptionStatus === "incomplete_expired";
  const isUnpaid = subscriptionStatus === "unpaid";
  const hasAnySubscription =
    hasActiveSubscription || isPastDue || isPaused || isCanceled || isIncomplete || isUnpaid;

  return (
    <div className="p-4 md:p-8 space-y-6">
      {hasAnySubscription && (
        <HeaderActions>
          <Button
            variant="outline"
            size="sm"
            onClick={() => createPortal.mutate()}
            disabled={createPortal.isPending}
          >
            <ExternalLink className="h-4 w-4" />
            <span className="sr-only">Manage Subscription</span>
          </Button>
        </HeaderActions>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <CreditCard className="h-5 w-5" />
            Subscription Status
          </CardTitle>
          <CardDescription>Your current billing plan</CardDescription>
        </CardHeader>
        <CardContent>
          {hasActiveSubscription ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Badge variant="default">
                  {subscriptionStatus === "trialing" ? "Trialing" : "Active"}
                </Badge>
                {billingAccount?.cancelAtPeriodEnd && (
                  <Badge variant="secondary">Cancels at period end</Badge>
                )}
              </div>
              {billingAccount?.currentPeriodEnd && (
                <p className="text-sm text-muted-foreground">
                  {subscriptionStatus === "trialing" ? "Trial ends: " : "Current period ends: "}
                  {format(new Date(billingAccount.currentPeriodEnd), "PPP")}
                </p>
              )}
            </div>
          ) : isPastDue || isUnpaid ? (
            <div className="space-y-4">
              <Badge variant="destructive">{isPastDue ? "Past Due" : "Unpaid"}</Badge>
              <p className="text-sm text-muted-foreground">
                Your payment is {isPastDue ? "past due" : "unpaid"}. Please update your payment
                method.
              </p>
              <Button onClick={() => createPortal.mutate()} disabled={createPortal.isPending}>
                Update Payment Method
              </Button>
            </div>
          ) : isPaused ? (
            <div className="space-y-4">
              <Badge variant="secondary">Paused</Badge>
              <p className="text-sm text-muted-foreground">
                Your subscription is paused. You can resume it from the billing portal.
              </p>
              <Button onClick={() => createPortal.mutate()} disabled={createPortal.isPending}>
                Manage Subscription
              </Button>
            </div>
          ) : isCanceled ? (
            <div className="space-y-4">
              <Badge variant="secondary">Canceled</Badge>
              <p className="text-sm text-muted-foreground">
                Your subscription has been canceled. Subscribe again to continue using
                iterate&apos;s AI-powered features.
              </p>
              <Button onClick={() => createCheckout.mutate()} disabled={createCheckout.isPending}>
                {createCheckout.isPending ? "Loading..." : "Subscribe Again"}
              </Button>
            </div>
          ) : isIncomplete ? (
            <div className="space-y-4">
              <Badge variant="destructive">Incomplete</Badge>
              <p className="text-sm text-muted-foreground">
                Your subscription setup is incomplete. Please complete the payment process.
              </p>
              <Button onClick={() => createPortal.mutate()} disabled={createPortal.isPending}>
                Complete Setup
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <Badge variant="secondary">No Subscription</Badge>
              <p className="text-sm text-muted-foreground">
                Subscribe to start using iterate&apos;s AI-powered features.
              </p>
              <Button onClick={() => createCheckout.mutate()} disabled={createCheckout.isPending}>
                {createCheckout.isPending ? "Loading..." : "Subscribe Now"}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
