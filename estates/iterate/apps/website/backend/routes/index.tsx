import { useEffect, useRef, useState } from "react";
import SiteHeader from "../components/SiteHeader.tsx";
import SiteFooter from "../components/SiteFooter.tsx";
import Member from "../components/Member.tsx";
import Investors from "../components/Investors.tsx";
import { Button } from "../components/Button.tsx";
import DisplayCards from "../components/ui/display-cards.tsx";
import CalendarModal from "../components/CalendarModal.tsx";
import jonasImg from "../assets/jonas.jpg?url";
import zakImg from "../assets/zak.png?url";
import francineImg from "../assets/francine.png?url";
import nickImg from "../assets/nick.png?url";
import rahulImg from "../assets/rahul.png?url";
import mishaImg from "../assets/misha.png?url";
//

export default function Home() {
  const addToSlackRef = useRef<HTMLButtonElement>(null);
  const [isCalendarOpen, setIsCalendarOpen] = useState(false);
  // const [setShowSlackButton] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isCmdOrCtrl = e.metaKey || e.ctrlKey;
      if (isCmdOrCtrl && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setIsCalendarOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // useEffect(() => {
  //   // Check for easter egg query parameter
  //   const urlParams = new URLSearchParams(window.location.search);
  //   setShowSlackButton(urlParams.has("slack") || urlParams.has("beta"));
  // }, []);

  return (
    <div className="min-h-screen bg-white">
      <SiteHeader />

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-6 sm:px-8 md:px-10 pt-12 sm:pt-16 pb-8">
        {/* Hero section with monospace heading */}
        <div className="grid lg:grid-cols-2 gap-2 lg:gap-16 items-center">
          <div className="max-w-4xl">
            <h1 className="text-4xl sm:text-5xl mb-6 sm:mb-8 tracking-tight leading-tight font-bold headline-mark">
              Hi 👋 I’m @iterate, your new co-worker
            </h1>
            <h2 className="text-lg sm:text-xl text-gray-600 mb-6 sm:mb-8 leading-relaxed">
              I work like ChatGPT, but:
            </h2>
            <div className="text-lg sm:text-xl text-gray-600 mb-6 sm:mb-8 leading-relaxed space-y-2">
              <p>...live in Slack</p>
              <p>...multiplayer</p>
              <p>...connect with your stack using MCP servers</p>
              <p>...based on your rules/*.md</p>
            </div>
            <div className="flex items-center gap-3 sm:gap-5 mb-6 sm:mb-24">
              <Button
                ref={addToSlackRef}
                className="w-64"
                size="lg"
                onClick={() => setIsCalendarOpen(true)}
              >
                <span>Free installation</span>
                <span className="hidden sm:flex items-center gap-2 ml-3">
                  <kbd className="keycap keycap-invert" data-key="cmd">
                    ⌘
                  </kbd>
                  <kbd className="keycap keycap-invert" data-key="k">
                    K
                  </kbd>
                </span>
              </Button>
            </div>
          </div>
          <div className="block lg:hidden mt-4 mb-8">
            <DisplayCards />
          </div>
          <div className="hidden lg:block">
            <DisplayCards />
          </div>
        </div>

        {/* <div className="flex items-center gap-3 sm:gap-5 mb-6 sm:mb-10">
            <Button 
              ref={addToSlackRef} 
              className="w-64" 
              size="lg"
              onClick={() => setIsCalendarOpen(true)}
            >
              <span>Free installation</span>
              <span className="hidden sm:flex items-center gap-2 ml-3">
                <kbd className="keycap keycap-invert" data-key="cmd">⌘</kbd>
                <kbd className="keycap keycap-invert" data-key="k">K</kbd>
              </span>
            </Button>
        //     {/* Easter egg Add to Slack button /}
        //     {showSlackButton && (
        //       <Button 
        //         variant="ghost"
        //         size="sm"
        //         className="text-xs text-gray-500 hover:text-gray-700"
        //         onClick={() => window.location.href = `${APP_URLS.bios}/claim`}
        //       >
        //         Add to Slack (beta)
        //       </Button>
        //     )}
        //   </div>
        //   </div>
        //   <div className="block lg:hidden mt-4 mb-8">
        //     <DisplayCards />
        //   </div>
        //   <div className="hidden lg:block">
        //     <DisplayCards />
        //   </div>
        // </div> */}

        {/* Removed terminal-style helper block per request */}

        {/* Additional copy (replaces operational capacity table) */}
        <section className="mt-2 sm:mt-4 mb-20">
          <h2 className="text-2xl font-bold mb-8">How I work</h2>
          <div className="prose text-gray-700">
            <ul>
              <li>
                <strong>Invite me to Slack.</strong> Message me with requests in DMs, channels, or
                threads - just like you would any other coworker.
              </li>
              <li>
                <strong>Give me access to your tools.</strong> I can take actions across GitHub,
                Linear, Notion, and more.
              </li>
              <li>
                <strong>Fine-tune my behaviour:</strong> Customise me using natural language, just
                add rules/*.md in a git repo you control.
              </li>
            </ul>
          </div>
        </section>

        {/* Why use iterate section */}
        <section className="mt-20 mb-20">
          <h2 className="text-2xl font-bold mb-8">Why teams choose iterate</h2>
          <div className="prose text-gray-700 max-w-3xl">
            <ul className="space-y-3">
              <li>
                <strong>You own your bot.</strong> Control iterate's behavior through simple files
                in a git repo you own. No need to trust some random web app with your company's
                context and memories.
              </li>
              <li>
                <strong>Built for teams.</strong> Your whole team can use iterate together. Jam on
                designs, debug production issues, whatever - it's multiplayer by default and lives
                in Slack.
              </li>
              <li>
                <strong>Customize everything.</strong> Write your own system prompts, add custom
                rules, share configs with other teams.
              </li>
              <li>
                <strong>MCP-enabled.</strong> Connect any MCP server to give iterate new abilities.
              </li>
            </ul>
          </div>
        </section>

        {/* Pricing (commented out)
<section className="mb-24" id="pricing">
  <h2 className="text-2xl font-bold mb-8">Pricing</h2>
  <div className="brutal-card brutal-dots p-6 w-full">
      <div className="text-3xl font-semibold mb-4">$100/month + API cost</div>
      <div className="mb-6 text-gray-700">
        <p className="font-semibold mb-3">One plan. Everything included:</p>
        <ul className="space-y-2 text-gray-600">
          <li className="flex items-start">
            <span className="mr-2">•</span>
            <span>System prompts, rules and context fully customisable in your own git repo</span>
          </li>
          <li className="flex items-start">
            <span className="mr-2">•</span>
            <span>Free bespoke installation and setup with the former co-founder of Monzo</span>
          </li>
          <li className="flex items-start">
            <span className="mr-2">•</span>
            <span>Extend with your own MCP servers</span>
          </li>
        </ul>
      </div>
      <div className="flex items-center gap-3 sm:gap-5">
        <Button 
          className="w-64" 
          size="lg"
          onClick={() => setIsCalendarOpen(true)}
        >
          <span>Free installation</span>
          <span className="hidden sm:flex items-center gap-2 ml-3">
            <kbd className="keycap keycap-invert" data-key="cmd">⌘</kbd>
            <kbd className="keycap keycap-invert" data-key="k">K</kbd>
          </span>
        </Button>
        Easter egg Add to Slack button:
        {showSlackButton && (
          <Button 
            variant="ghost"
            size="sm"
            className="text-xs text-gray-500 hover:text-gray-700"
            onClick={() => window.location.href = 'https://bios.iterate.iterate.com/claim'}
          >
            Add to Slack (beta)
          </Button>
        )}
      </div>
  </div>
</section>
        */}

        {/* Team section */}
        <div className="mb-20">
          <h2 className="text-2xl font-bold mb-8">Built by operators, for operators</h2>
          <p className="text-gray-600 mb-8">
            Founded by the former co-founder & CTO of Monzo. We're a technical team that understands
            the operational challenges of scaling startups.
          </p>
          <div className="dashed-grid dashed-cols-2">
            <div className="cell p-5">
              <Member
                name="Jonas Templestein"
                companyRole={
                  <>
                    Founder,{" "}
                    <abbr className="no-underline" title="Chief Executive Officer">
                      CEO
                    </abbr>
                  </>
                }
                image={jonasImg}
                social={{
                  x: "https://x.com/jonas",
                  linkedIn: "https://linkedin.com/in/jonashuckestein",
                }}
                className="mb-0"
              />
            </div>
            <div className="cell p-5">
              <Member
                name="Zak Davydov"
                companyRole="Founding Team"
                image={zakImg}
                social={{
                  x: "https://x.com/zakdavydov",
                  linkedIn: "https://www.linkedin.com/in/zakhar-davydov/",
                }}
                className="mb-0"
              />
            </div>

            <div className="cell p-5">
              <Member
                name="Francine Loza"
                companyRole="Founding Team"
                image={francineImg}
                social={{
                  x: "https://x.com/flozaii",
                  linkedIn: "https://www.linkedin.com/in/francine-loza-9b569575/",
                }}
                className="mb-0"
              />
            </div>
            <div className="cell p-5">
              <Member
                name="Nick Blow"
                companyRole="Founding Team"
                image={nickImg}
                social={{
                  x: "https://x.com/nickblow",
                  linkedIn: "https://www.linkedin.com/in/nickblow/",
                }}
                className="mb-0"
              />
            </div>
            <div className="cell p-5">
              <Member
                name="Rahul Mishra"
                companyRole="Founding Team"
                image={rahulImg}
                social={{
                  x: "https://x.com/blankparticle",
                  linkedIn: "https://www.linkedin.com/in/blankparticle/",
                }}
                className="mb-0"
              />
            </div>
            <div className="cell p-5">
              <Member
                name="Misha Kaletsky"
                companyRole="Founding Team"
                image={mishaImg}
                social={{
                  x: "https://x.com/mmkalmmkal",
                  linkedIn: "https://www.linkedin.com/in/mkaletsky/",
                }}
                className="mb-0"
              />
            </div>
          </div>
          <p className="mt-8 text-gray-600">Backed by world-class investors:</p>
          <div className="mt-6">
            <Investors />
          </div>
        </div>
      </main>

      <SiteFooter />
      <CalendarModal isOpen={isCalendarOpen} onClose={() => setIsCalendarOpen(false)} />
    </div>
  );
}
