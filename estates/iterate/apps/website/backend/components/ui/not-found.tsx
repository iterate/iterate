import { Link } from "../Link";
import { Button } from "./button";

export function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background text-foreground">
      <div className="mx-auto max-w-md text-center">
        <h1 className="mb-4 text-6xl font-bold">404</h1>
        <p className="mb-8 text-xl text-muted-foreground">
          Oops! The page you're looking for doesn't exist.
        </p>
        <Button asChild>
          <Link to="/">Go back home</Link>
        </Button>
      </div>
    </div>
  );
}
