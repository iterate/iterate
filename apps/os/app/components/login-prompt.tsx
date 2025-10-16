import { useRef, type ComponentPropsWithRef } from "react";
import { useNavigate } from "react-router";
import { cn } from "../lib/utils.ts";
import { AnimatedBeam } from "./ui/animated-beam.tsx";
import { IterateLetterI } from "./ui/iterate-logos.tsx";
import { Button } from "./ui/button.tsx";

function LogoBox({ className, children, ref }: ComponentPropsWithRef<"div">) {
  return (
    <div
      ref={ref}
      className={cn(
        "relative z-30 flex size-12 sm:size-16 lg:size-20 items-center justify-center rounded-2xl sm:rounded-3xl overflow-hidden bg-white shadow-sm dark:shadow-[0_0_17px_rgba(255,255,255,0.45)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function LoginPrompt() {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null as unknown as HTMLDivElement);
  const div1Ref = useRef<HTMLDivElement>(null as unknown as HTMLDivElement);
  const div2Ref = useRef<HTMLDivElement>(null as unknown as HTMLDivElement);
  const div3Ref = useRef<HTMLDivElement>(null as unknown as HTMLDivElement);
  const div4Ref = useRef<HTMLDivElement>(null as unknown as HTMLDivElement);
  const div5Ref = useRef<HTMLDivElement>(null as unknown as HTMLDivElement);
  const div6Ref = useRef<HTMLDivElement>(null as unknown as HTMLDivElement);
  const div7Ref = useRef<HTMLDivElement>(null as unknown as HTMLDivElement);

  return (
    <div className="flex h-full w-full items-center justify-center">
      <div className="w-full max-w-[1000px] px-4 py-8 sm:p-8">
        <div className="flex flex-col items-center justify-center space-y-6 sm:space-y-8 text-center">
          <div
            className="relative flex h-[300px] sm:h-[400px] lg:h-[600px] w-full min-w-[320px] sm:min-w-[600px] lg:min-w-[900px] items-center justify-center overflow-hidden px-8 sm:px-12 lg:px-16"
            ref={containerRef}
          >
            {/* Render beams first so they appear behind the logos */}
            <div className="absolute inset-0 z-0">
              <AnimatedBeam
                containerRef={containerRef}
                fromRef={div1Ref}
                toRef={div4Ref}
                curvature={1}
                delay={300}
              />
              <AnimatedBeam
                containerRef={containerRef}
                fromRef={div2Ref}
                toRef={div4Ref}
                curvature={0}
                delay={800}
              />
              <AnimatedBeam
                containerRef={containerRef}
                fromRef={div3Ref}
                toRef={div4Ref}
                curvature={1}
                delay={1300}
              />
              <AnimatedBeam
                containerRef={containerRef}
                fromRef={div5Ref}
                toRef={div4Ref}
                curvature={1}
                reverse
                delay={1800}
              />
              <AnimatedBeam
                containerRef={containerRef}
                fromRef={div6Ref}
                toRef={div4Ref}
                curvature={0}
                reverse
                delay={2300}
              />
              <AnimatedBeam
                containerRef={containerRef}
                fromRef={div7Ref}
                toRef={div4Ref}
                curvature={1}
                reverse
                delay={2800}
              />
            </div>

            <div className="relative flex w-full h-full max-w-7xl max-h-[400px] sm:max-h-[450px] lg:max-h-[550px] items-center justify-center">
              {/* Center Iterate Logo */}
              <div
                ref={div4Ref}
                className="relative z-30 flex size-16 sm:size-20 lg:size-28 items-center justify-center"
              >
                <LogoBox className="bg-transparent shadow-[0_0_20px_rgba(0,0,0,0.3)] dark:shadow-[0_0_20px_rgba(255,255,255,0.8)]">
                  <IterateLetterI className="w-100 h-100 text-6xl" />
                </LogoBox>
              </div>

              {/* Left side - staggered positions */}
              <div className="absolute left-8 top-8 sm:left-12 sm:top-12 lg:left-20 lg:top-20">
                <LogoBox ref={div1Ref}>
                  <img
                    src="https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/cb/26/f8/cb26f8ad-3ae6-d097-d46e-19fcb298268e/logo_gsa_gradient_ios_color-0-1x_U007epad-0-0-0-1-0-0-sRGB-0-0-85-220-0.png/460x0w.webp"
                    alt="Google Workspace"
                    className="h-full w-full object-contain"
                  />
                </LogoBox>
              </div>

              <div className="absolute left-0 top-1/2 -translate-y-1/2 sm:left-2 lg:left-0">
                <LogoBox ref={div2Ref}>
                  <img
                    src="https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/81/c8/30/81c8304c-acc4-7833-bbd2-4cf2078b68ee/AppIconProd-0-0-1x_U007emarketing-0-8-0-85-220.png/460x0w.webp"
                    alt="Deel"
                    className="h-full w-full object-contain"
                  />
                </LogoBox>
              </div>

              <div className="absolute left-8 bottom-8 sm:left-12 sm:bottom-12 lg:left-20 lg:bottom-20">
                <LogoBox ref={div3Ref}>
                  <img
                    src="https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/24/7a/10/247a10d2-e253-9a5d-6687-9da5070b26e6/AppIcon-0-0-1x_U007emarketing-0-8-0-85-220.png/460x0w.webp"
                    alt="Slack"
                    className="h-full w-full object-contain"
                  />
                </LogoBox>
              </div>

              {/* Right side - staggered positions */}
              <div className="absolute right-8 top-8 sm:right-12 sm:top-12 lg:right-20 lg:top-20">
                <LogoBox ref={div5Ref}>
                  <img
                    src="https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/cb/d7/e4/cbd7e44f-aa4f-7655-01d8-8924d1edcecb/AppIconProd-0-0-1x_U007emarketing-0-11-0-85-220.png/460x0w.webp"
                    alt="Notion"
                    className="h-full w-full object-contain"
                  />
                </LogoBox>
              </div>

              <div className="absolute right-0 top-1/2 -translate-y-1/2 sm:right-2 lg:right-0">
                <LogoBox ref={div6Ref}>
                  <img
                    src="https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/75/a3/f0/75a3f087-4298-7e10-a31c-ea61eb7afe1f/AppIcon-0-0-1x_U007epad-0-1-0-85-220.png/460x0w.webp"
                    alt="Wise"
                    className="h-full w-full object-contain"
                  />
                </LogoBox>
              </div>

              <div className="absolute right-8 bottom-8 sm:right-12 sm:bottom-12 lg:right-20 lg:bottom-20">
                <LogoBox ref={div7Ref}>
                  <img
                    src="https://is1-ssl.mzstatic.com/image/thumb/Purple211/v4/51/9b/67/519b672e-e71d-22f0-f76d-345d9face544/AppIcon-0-0-1x_U007epad-0-1-0-85-220.png/460x0w.webp"
                    alt="Xero"
                    className="h-full w-full object-contain"
                  />
                </LogoBox>
              </div>
            </div>
          </div>

          <div className="w-full flex flex-col items-center space-y-6 pb-8 sm:pb-4 max-w-sm mx-auto">
            <div className="space-y-2 text-center">
              <h1 className="text-4xl font-bold tracking-tight">
                Hi! I am{" "}
                <span className="inline-flex items-baseline rounded bg-[#1264a3]/10 dark:bg-[#1264a3]/20 px-1 py-0.5 text-[#1264a3] dark:text-[#1d9bd1] font-semibold">
                  @iterate
                </span>
              </h1>
              <p className="text-muted-foreground text-lg">AI agent that works in your Slack</p>
            </div>
            <Button
              onClick={() => navigate("/get-started")}
              size="lg"
              className="w-full h-14 text-lg"
            >
              Get Started
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
