import { type ReactNode } from "react";

type OnboardingStepLayoutProps = {
  stepText?: string;
  title: string;
  description?: string;
  children: ReactNode;
  maxWidthClass?: string;
};

export function OnboardingStepLayout({
  stepText,
  title,
  description,
  children,
  maxWidthClass = "max-w-4xl",
}: OnboardingStepLayoutProps) {
  return (
    <div className="flex justify-center">
      <div className={`w-full ${maxWidthClass} space-y-8`}>
        <div className="space-y-3">
          {stepText ? <p className="text-muted-foreground">{stepText}</p> : null}
          <h2 className="text-2xl font-semibold">{title}</h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>

        {children}
      </div>
    </div>
  );
}
