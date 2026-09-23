import { buttonVariants } from "@iterate-com/ui/components/button";

/** The identity providers this deployment accepts, each a link that starts its sign-in. */
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
    <div className="flex flex-col gap-2">
      {providers.map((provider) =>
        provider.href ? (
          <a
            key={provider.name}
            href={provider.href}
            aria-label={`Continue with ${provider.name}`}
            className={buttonVariants({ variant: "outline", size: "lg" })}
          >
            <img src={provider.logo} alt="" width={18} height={18} />
            {provider.name}
          </a>
        ) : null,
      )}
    </div>
  );
}
