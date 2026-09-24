import { buttonVariants } from "@iterate-com/ui/components/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@iterate-com/ui/components/card";
import { cn } from "cn";
import { stepUpUrl } from "../lib/scopes.ts";

/** The dash asked for `account` and the person unticked it: the page offers the step-up instead of
 *  the FORBIDDEN the account's API answers with. */
export function AllowAccount({
  title,
  next,
  description,
  action,
}: {
  title: string;
  next: string;
  description: string;
  action: string;
}) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 md:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <Card>
        <CardHeader>
          <CardTitle>Account permission</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          <a href={stepUpUrl(next)} className={cn(buttonVariants({ variant: "outline" }))}>
            {action}
          </a>
        </CardContent>
      </Card>
    </div>
  );
}
