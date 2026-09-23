import { buttonVariants } from "@iterate-com/ui/components/button";
import { cn } from "@iterate-com/ui/lib/utils";

/** The identity providers this deployment accepts, each a link that starts its sign-in — side by
 *  side, one under the other only where they do not fit. */
export function SignInProviders({
  google,
  cloudflare,
}: {
  google: string | null;
  cloudflare: string | null;
}) {
  const providers = [
    { name: "Google", href: google, logo: "/google-logo.svg" },
    { name: "Cloudflare", href: cloudflare, logo: "/cloudflare-logo.svg" },
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
