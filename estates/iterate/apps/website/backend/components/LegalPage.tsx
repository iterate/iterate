import type { ReactNode } from "react";
import { cn } from "../lib/utils.ts";

interface LegalPageProps {
  title: string;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}

export default function LegalPage({ title, children, className, bodyClassName }: LegalPageProps) {
  return (
    <section
      className={cn(
        "mx-auto w-[min(100%,clamp(22rem,78vw,78rem))] px-[clamp(1.5rem,5vw,3.75rem)]",
        className,
      )}
    >
      <h1 className="text-3xl font-bold mb-8 text-gray-900 headline-mark">{title}</h1>
      <div
        className={cn(
          "prose text-gray-700 max-w-none w-full text-[clamp(1.05rem,0.45vw+1rem,1.25rem)] leading-[clamp(1.7,0.35vw+1.6,1.9)] [&_p]:max-w-full [&_li]:max-w-full",
          bodyClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}
