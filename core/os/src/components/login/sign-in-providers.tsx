import { cn } from "cn";
import { buttonVariants } from "../ui/button.tsx";
import type { SignInProvider } from "./providers.ts";

/** Every provider, each a link that starts its sign-in — side by side, one under the other only
 *  where they do not fit. */
export function SignInProviders({ providers }: { providers: SignInProvider[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(120px,1fr))] gap-2.5">
      {providers.map((provider) => (
        <a
          key={provider.key}
          href={provider.href}
          aria-label={`Continue with ${provider.name}`}
          // cn() lets outline's border beat the base's transparent one, as <Button> does
          className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-11 gap-2")}
        >
          <img src={provider.logo} alt="" width={20} height={20} className="size-5" />
          {provider.name}
        </a>
      ))}
    </div>
  );
}

/** The way a link suggested (`provider_hint`), alone, and the way back to every other: the same
 *  page without the suggestion. */
export function RecommendedSignIn({
  provider,
  everyWay,
}: {
  provider: SignInProvider;
  everyWay: string;
}) {
  return (
    <div className="flex flex-col gap-3">
      <a
        href={provider.href}
        className={cn(buttonVariants({ variant: "outline", size: "lg" }), "h-11 gap-2")}
      >
        <img src={provider.logo} alt="" width={20} height={20} className="size-5" />
        Sign in with {provider.name}
      </a>
      <p className="text-center text-xs text-muted-foreground">
        or{" "}
        <a href={everyWay} className="underline underline-offset-4 hover:text-foreground">
          sign in another way
        </a>
      </p>
    </div>
  );
}
