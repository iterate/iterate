import { Spinner } from "./ui/spinner.tsx";

export function GlobalLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Spinner className="h-8 w-8" />
    </div>
  );
}
