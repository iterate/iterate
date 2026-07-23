import { Alert, AlertDescription, AlertTitle } from "@iterate-com/ui/components/alert";

export function AuthRedirectError({
  error,
  errorDescription,
}: {
  error: string | undefined;
  errorDescription: string | undefined;
}) {
  if (!error) return null;

  return (
    <Alert variant="destructive">
      <AlertTitle>Sign-in failed</AlertTitle>
      <AlertDescription>{errorDescription || humanizeError(error)}</AlertDescription>
    </Alert>
  );
}

function humanizeError(error: string) {
  const message = error.replaceAll("_", " ").trim();
  return message.charAt(0).toUpperCase() + message.slice(1);
}
