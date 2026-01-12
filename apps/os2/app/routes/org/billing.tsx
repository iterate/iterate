import { useEffect } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { CreditCard, ExternalLink, Zap } from "lucide-react";
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

export const Route = createFileRoute("/_auth.layout/orgs/$organizationSlug/billing")({
  component: BillingPage,
});

function BillingPage() {
  const params = useParams({ from: "/_auth.layout/orgs/$organizationSlug/billing" });
  const urlParams = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : "",
  );
  const success = urlParams.get("success") === "true";

  useEffect(() => {
    if (success) {
      toast.success("Subscription activated successfully!");
    }
  }, [success]);

  const { data: billingAccount, isLoading: billingLoading } = useQuery(
    trpc.billing.getBillingAccount.queryOptions({
      organizationSlug: params.organizationSlug,
    }),
  );

  const { data: usageSummary, isLoading: usageLoading } = useQuery(
    trpc.billing.getUsageSummary.queryOptions({
      organizationSlug: params.organizationSlug,
    }),
  );

  const createCheckout = useMutation({
    mutationFn: () =>
      trpcClient.billing.createCheckoutSession.mutate({
        organizationSlug: params.organizationSlug,
      }),
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

  if (billingLoading || usageLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Spinner />
      </div>
    );
  }

  const hasSubscription = billingAccount?.subscriptionStatus === "active";
  const isPastDue = billingAccount?.subscriptionStatus === "past_due";

  return (
    <div className="p-8 max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Billing</h1>
        {hasSubscription && (
          <Button
            variant="outline"
            onClick={() => createPortal.mutate()}
            disabled={createPortal.isPending}
          >
            <ExternalLink className="mr-2 h-4 w-4" />
            Manage Subscription
          </Button>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5" />
              Subscription Status
            </CardTitle>
            <CardDescription>Your current billing plan</CardDescription>
          </CardHeader>
          <CardContent>
            {hasSubscription ? (
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Badge variant="default">Active</Badge>
                  {billingAccount?.cancelAtPeriodEnd && (
                    <Badge variant="secondary">Cancels at period end</Badge>
                  )}
                </div>
                {billingAccount?.currentPeriodEnd && (
                  <p className="text-sm text-muted-foreground">
                    Current period ends: {format(new Date(billingAccount.currentPeriodEnd), "PPP")}
                  </p>
                )}
              </div>
            ) : isPastDue ? (
              <div className="space-y-4">
                <Badge variant="destructive">Past Due</Badge>
                <p className="text-sm text-muted-foreground">
                  Your payment is past due. Please update your payment method.
                </p>
                <Button onClick={() => createPortal.mutate()} disabled={createPortal.isPending}>
                  Update Payment Method
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

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Zap className="h-5 w-5" />
              Usage This Period
            </CardTitle>
            <CardDescription>Your current billing period usage</CardDescription>
          </CardHeader>
          <CardContent>
            {usageSummary ? (
              <div className="space-y-4">
                <div className="text-3xl font-bold">{usageSummary.totalUsage.toLocaleString()}</div>
                <p className="text-sm text-muted-foreground">tokens used</p>
                {usageSummary.periodStart && usageSummary.periodEnd && (
                  <p className="text-xs text-muted-foreground">
                    {format(new Date(usageSummary.periodStart), "MMM d")} -{" "}
                    {format(new Date(usageSummary.periodEnd), "MMM d, yyyy")}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No usage data available</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Pricing</CardTitle>
          <CardDescription>Usage-based pricing for AI features</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Free Tier</p>
                  <p className="text-sm text-muted-foreground">First 2,000,000 tokens per month</p>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-bold">$0</p>
                </div>
              </div>
            </div>
            <div className="rounded-lg border p-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Usage Rate</p>
                  <p className="text-sm text-muted-foreground">After free tier</p>
                </div>
                <div className="text-right">
                  <p className="text-2xl font-bold">$0.01</p>
                  <p className="text-sm text-muted-foreground">per 1,000 tokens</p>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
