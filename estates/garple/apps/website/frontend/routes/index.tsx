import { useDebounce } from "@uidotdev/usehooks";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Speech, Ban, ShieldCheck, ChevronsUp } from "lucide-react";
import { Link } from "react-router";
import { useTRPC } from "../providers.tsx";
import { Button } from "../components/ui/button.tsx";
import { Input } from "../components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select.tsx";

export function Home() {
  const [nameFilter, setNameFilter] = useState("");
  const [availabilityFilter, setAvailabilityFilter] = useState<"available" | "sold" | "both">(
    "both",
  );
  const [showReset, setShowReset] = useState(false);
  const trpc = useTRPC();

  const debouncedNameFilter = useDebounce(nameFilter, 500);

  const domainsQuery = useQuery(
    trpc.domains.list.queryOptions({
      nameFilter: debouncedNameFilter || undefined,
      availabilityFilter,
    }),
  );

  const formatPrice = (amountInMinorUnits: number, currency: string) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amountInMinorUnits / 100);
  };

  const [loadingDomainId, setLoadingDomainId] = useState<string | null>(null);

  const createCheckoutSession = useMutation(
    trpc.domains.createStripeCheckoutSession.mutationOptions(),
  );

  const handleBuyClick = async (domain: any) => {
    if (domain.purchased) {
      return;
    }

    if (loadingDomainId === domain.id) {
      return;
    }

    setLoadingDomainId(domain.id);
    try {
      const result = await createCheckoutSession.mutateAsync({
        domainId: domain.id,
        successUrl: `${window.location.origin}/domains/${domain.nameWithTld}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${window.location.origin}/d/${domain.nameWithTld}`,
      });

      if (result.checkoutUrl) {
        window.location.href = result.checkoutUrl;
      }
    } catch (error) {
      console.error("Failed to create checkout session:", error);
    } finally {
      setLoadingDomainId(null);
    }
  };

  const resetFilters = () => {
    setNameFilter("");
    setAvailabilityFilter("both");
    setShowReset(false);
  };

  if (domainsQuery.isLoading) {
    return (
      <div className="max-w-2xl mx-auto p-6 space-y-8">
        <div className="text-center">Loading...</div>
      </div>
    );
  }

  // If we have no domains data, show empty state
  if (!domainsQuery.data) {
    return (
      <div className="max-w-2xl mx-auto p-6 space-y-8">
        <div className="text-center">No domains found</div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-8">
      {/* Header */}
      <div className="space-y-4">
        <div className="flex items-center space-x-2">
          <Link
            to="/"
            className="inline-block px-3 py-1 bg-green-50 dark:bg-gray-800 border border-green-600 dark:border-green-400 rounded-full"
          >
            <span className="text-green-700 dark:text-green-400 text-sm font-medium">
              🌱 GARPLE
            </span>
          </Link>
          <span className="text-gray-500 dark:text-gray-400 text-sm">
            by{" "}
            <a href="https://iterate.com" className="hover:underline">
              iterate
            </a>
          </span>
        </div>
        <h1 className="text-4xl font-bold text-gray-900 dark:text-white">
          Buy a .com domain for your startup
        </h1>
        <blockquote className="italic text-gray-600 dark:text-gray-400">
          "If you have a US startup called X and you don't have x.com, you should probably change
          your name." —{" "}
          <a
            href="https://paulgraham.com/name.html"
            className="text-blue-600 dark:text-blue-400 hover:underline"
          >
            Paul Graham
          </a>
        </blockquote>
        <div className="space-y-2 text-gray-700 dark:text-gray-300">
          <p>A short and easy-to-say .com domain is all you need. Just look at Google and Hooli!</p>
          <p>We'll send you the transfer code straight away so you can get back to building.</p>
        </div>
        <hr className="border-gray-200 dark:border-gray-700" />
      </div>

      {/* Benefits Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="flex items-start space-x-3">
          <div className="w-12 h-12 bg-green-200 dark:bg-green-900 rounded-full flex items-center justify-center p-2">
            <Speech className="w-4 h-4 text-green-700 dark:text-green-400" />
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white">Short and easy to say</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              Our domains are "pseudowords" - short, easy to say, without any real meaning. All
              domains pass the{" "}
              <a
                href="https://www.namecheap.com/blog/domain-name-radio-test/"
                className="text-blue-600 dark:text-blue-400 hover:underline"
              >
                radio test
              </a>
              .
            </p>
          </div>
        </div>

        <div className="flex items-start space-x-3">
          <div className="w-12 h-12 bg-green-200 dark:bg-green-900 rounded-full flex items-center justify-center p-2">
            <Ban className="w-4 h-4 text-green-700 dark:text-green-400" />
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white">No baggage associated</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              Just like "Google" or "Twilio", our domains are totally unique and people don't
              associate any meaning with them.
            </p>
          </div>
        </div>

        <div className="flex items-start space-x-3">
          <div className="w-12 h-12 bg-green-200 dark:bg-green-900 rounded-full flex items-center justify-center p-2">
            <ShieldCheck className="w-4 h-4 text-green-700 dark:text-green-400" />
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white">Fast, secure and easy</h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              We use Stripe to process payments. Get your new domain up and running in less than 30
              minutes.
            </p>
          </div>
        </div>

        <div className="flex items-start space-x-3">
          <div className="w-12 h-12 bg-green-200 dark:bg-green-900 rounded-full flex items-center justify-center p-2">
            <ChevronsUp className="w-4 h-4 text-green-700 dark:text-green-400" />
          </div>
          <div>
            <h3 className="font-semibold text-gray-900 dark:text-white">
              Instant SEO Optimisation
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
              Take the #1 spot in the Google search results and register an uncontested trademark.
            </p>
          </div>
        </div>
      </div>

      {/* Logo Row */}
      <div className="space-y-4">
        <div className="grid grid-cols-3 md:grid-cols-6 gap-4 items-center justify-items-center filter grayscale">
          <img src="/logos/google.svg" alt="Google" className="h-6 opacity-80 dark:opacity-90" />
          <img src="/logos/monzo.svg" alt="Monzo" className="h-6 opacity-80 dark:opacity-90" />
          <img src="/logos/hooli.svg" alt="Hooli" className="h-6 opacity-80 dark:opacity-90" />
          <img src="/logos/reddit.svg" alt="Reddit" className="h-6 opacity-80 dark:opacity-90" />
          <img src="/logos/twilio.svg" alt="Twilio" className="h-6 opacity-80 dark:opacity-90" />
          <img src="/logos/nustom.svg" alt="Nustom" className="h-6 opacity-80 dark:opacity-90" />
        </div>
        <div className="text-right">
          <span className="text-xs text-gray-400 dark:text-gray-500">
            * companies who might have gotten their name from here
          </span>
        </div>
      </div>

      {/* Domain List */}
      <div className="space-y-4">
        {/* Filters */}
        <div className="flex gap-4 items-center">
          <div className="flex-1 relative">
            <Input
              placeholder="Filter by name"
              value={nameFilter}
              onChange={(e) => setNameFilter(e.target.value)}
              className="flex-1 dark:bg-gray-800 dark:border-gray-600 dark:text-white dark:placeholder-gray-400"
            />
            {(domainsQuery.isFetching || nameFilter !== debouncedNameFilter) && (
              <div className="absolute right-2 top-1/2 transform -translate-y-1/2">
                <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-600 rounded-full animate-spin" />
              </div>
            )}
          </div>
          <Select
            value={availabilityFilter}
            onValueChange={(value) => setAvailabilityFilter(value as any)}
          >
            <SelectTrigger className="w-48 dark:bg-gray-800 dark:border-gray-600 dark:text-white">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="dark:bg-gray-800 dark:border-gray-600">
              <SelectItem value="available" className="dark:text-white dark:focus:bg-gray-700">
                Available
              </SelectItem>
              <SelectItem value="sold" className="dark:text-white dark:focus:bg-gray-700">
                Sold
              </SelectItem>
              <SelectItem value="both" className="dark:text-white dark:focus:bg-gray-700">
                Available + Sold
              </SelectItem>
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            onClick={resetFilters}
            disabled={!showReset}
            className="dark:bg-gray-800 dark:border-gray-600 dark:text-white dark:hover:bg-gray-700 dark:disabled:bg-gray-900 dark:disabled:border-gray-700 dark:disabled:text-gray-500"
          >
            Reset
          </Button>
        </div>

        {/* Domain List */}
        <div className="space-y-2">
          {domainsQuery.data?.map((domain: any) => (
            <div
              key={domain.id}
              className="flex items-center justify-between py-3 border-b border-gray-200 dark:border-gray-700"
            >
              <Link
                to={`/d/${domain.nameWithTld}`}
                className="flex items-center space-x-2 cursor-pointer text-left"
                data-ph-capture-attribute-domain-name={domain.nameWithTld}
              >
                <span
                  className={`font-bold ${domain.purchased ? "text-gray-500 dark:text-gray-400" : "text-green-600 dark:text-green-400"}`}
                >
                  {domain.nameWithTld}
                  {domain.tier === "1" && !domain.purchased && " ✨"}
                </span>
              </Link>
              <div className="flex items-center space-x-4">
                {!domain.purchased && (
                  <span className="text-gray-700 dark:text-gray-300">
                    {formatPrice(domain.amountInMinorUnits, domain.currency)}
                  </span>
                )}
                {domain.purchased ? (
                  <span className="text-gray-500 dark:text-gray-400">Sold</span>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleBuyClick(domain)}
                    disabled={loadingDomainId === domain.id}
                    data-ph-capture-attribute-domain-name={domain.nameWithTld}
                  >
                    {loadingDomainId === domain.id ? "Loading..." : "Buy"}
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
