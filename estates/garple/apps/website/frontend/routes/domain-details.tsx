import { useParams } from "react-router";
import { useSuspenseQuery, useMutation } from "@tanstack/react-query";
import { Speech, Ban, ShieldCheck, ChevronsUp } from "lucide-react";
import { Link } from "react-router";
import { useTRPC } from "../providers.tsx";

export function DomainDetails() {
  const { domainNameWithTLD } = useParams<{ domainNameWithTLD: string }>();
  const trpc = useTRPC();

  // Call all hooks unconditionally at the top
  const { data: domain } = useSuspenseQuery(
    trpc.domains.getByName.queryOptions({
      nameWithTld: domainNameWithTLD || "",
    }),
  );

  const createCheckoutSession = useMutation(
    trpc.domains.createStripeCheckoutSession.mutationOptions(),
  );

  // Early returns after all hooks
  if (!domainNameWithTLD) {
    return <div>Domain not found</div>;
  }

  if (!domain) {
    return <div>Domain not found</div>;
  }

  const priceFormatted = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: domain.currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(domain.amountInMinorUnits / 100);

  const handlePurchase = async () => {
    const result = await createCheckoutSession.mutateAsync({
      domainId: domain.id,
      successUrl: `${window.location.origin}/domains/${domain.nameWithTld}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${window.location.origin}/d/${domain.nameWithTld}`,
    });

    if (result.checkoutUrl) {
      window.location.href = result.checkoutUrl;
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-8">
      {/* Logo */}
      <div className="flex items-center space-x-2">
        <Link
          to="/"
          className="inline-block px-3 py-1 bg-green-50 dark:bg-gray-800 border border-green-600 dark:border-green-400 rounded-full"
        >
          <span className="text-green-700 dark:text-green-400 text-sm font-medium">🌱 GARPLE</span>
        </Link>
        <span className="text-gray-500 dark:text-gray-400 text-sm">
          by{" "}
          <a href="https://iterate.com" className="hover:underline">
            iterate
          </a>
        </span>
      </div>

      {/* Header */}
      <div className="space-y-4">
        {domain.purchased ? (
          <div className="text-left">
            <h1 className="text-4xl font-bold text-gray-500 dark:text-gray-400">
              {domain.nameWithTld} has been sold
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mt-2">
              This domain has already found its perfect home.
            </p>
          </div>
        ) : (
          <div className="text-left space-y-4">
            <div className="flex items-center justify-between">
              <h1 className="text-4xl font-bold text-gray-900 dark:text-white">
                Buy {domain.nameWithTld} for {priceFormatted}
              </h1>
              <button
                className="bg-green-600 hover:bg-green-700 text-white font-medium py-2 px-4 rounded-md transition-colors disabled:opacity-50 cursor-pointer"
                onClick={handlePurchase}
                disabled={createCheckoutSession.isPending}
                type="button"
                data-ph-capture-attribute-domain-name={domain.nameWithTld}
              >
                {createCheckoutSession.isPending ? "Processing..." : "Buy Now"}
              </button>
            </div>
            <p className="text-gray-600 dark:text-gray-400">
              It's the perfect blank canvas for your project.
            </p>
          </div>
        )}
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

      {/* Footer */}
      <div className="pt-8 border-t border-gray-200 dark:border-gray-700">
        <div className="text-center space-y-2">
          <Link
            to="/"
            className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 text-sm"
          >
            View our other domains at {window.location.hostname}
          </Link>
          <div className="text-lg">🌱</div>
        </div>
      </div>
    </div>
  );
}
