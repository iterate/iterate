import { Button } from "./ui/button.tsx";

export function LoginCard({ redirectUrl }: { redirectUrl: string }) {
  const href = `/api/iterate-auth/login?redirectPath=${encodeURIComponent(redirectUrl)}`;
  return (
    <div className="w-full max-w-md space-y-6">
      <Button asChild className="w-full">
        <a href={href}>Sign in with Iterate</a>
      </Button>
    </div>
  );
}
