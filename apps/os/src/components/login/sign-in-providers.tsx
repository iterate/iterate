import { buttonVariants } from "@iterate-com/ui/components/button";
import { cn } from "cn";
import { INTEGRATION_PROVIDER_NAMES } from "iterate/api";

/** The identity providers this deployment accepts, each a link that starts its sign-in — side by
 *  side, one under the other only where they do not fit. `adminIssuer` is another iterate
 *  deployment its admins sign in through (admin-sign-in.ts), named by its host. */
export function SignInProviders({
  google,
  cloudflare,
  github,
  adminIssuer,
}: {
  google: string | null;
  cloudflare: string | null;
  github: string | null;
  adminIssuer: { host: string; href: string } | null;
}) {
  const providers = [
    { name: INTEGRATION_PROVIDER_NAMES.google, href: google, logo: "/google-logo.svg" },
    { name: INTEGRATION_PROVIDER_NAMES.github, href: github, logo: "/github-logo.svg" },
    { name: INTEGRATION_PROVIDER_NAMES.cloudflare, href: cloudflare, logo: "/cloudflare-logo.svg" },
    { name: adminIssuer?.host, href: adminIssuer?.href, logo: "/iterate-logo.svg" },
  ];
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2.5">
      {providers.map((provider) =>
        provider.href ? (
          <a
            key={provider.name}
            href={provider.href}
            aria-label={`Continue with ${provider.name}`}
            // cn() lets outline's border beat the base's transparent one, as <Button> does
            className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-11 gap-2")}
          >
            <img src={provider.logo} alt="" width={20} height={20} className="size-5" />
            {provider.name}
          </a>
        ) : null,
      )}
    </div>
  );
}
