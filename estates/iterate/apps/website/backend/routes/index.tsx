import { useEffect, useRef, useState } from "react";
import SiteHeader from "../components/site-header.tsx";
import SiteFooter from "../components/site-footer.tsx";
import Member from "../components/member.tsx";
import Investors from "../components/investors.tsx";
import { Button } from "../components/button.tsx";
import DisplayCards from "../components/ui/display-cards.tsx";
import CalendarModal from "../components/calendar-modal.tsx";
import jonasImg from "../assets/jonas.jpg?url";
import zakImg from "../assets/zak.png?url";
import nickImg from "../assets/nick.png?url";
import rahulImg from "../assets/rahul.png?url";
import mishaImg from "../assets/misha.png?url";
import slackIcon from "../assets/slack.svg?url";
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

  const handleAddToSlack = () => {
    // Redirect to the OS app endpoint which will handle the OAuth flow
    window.location.href = "https://os.iterate.com/login?autoSignin=slack";
  };

  return (
    <div className="min-h-screen bg-white">
      <SiteHeader />

      {/* Main content */}
      <main className="max-w-7xl mx-auto px-6 sm:px-8 md:px-10 pt-12 sm:pt-16 pb-8">
        {/* Hero section with monospace heading */}
        <div className="grid lg:grid-cols-2 gap-2 lg:gap-16 items-center">
          <div className="max-w-4xl">
            <h1 className="text-4xl sm:text-5xl mb-6 sm:mb-8 tracking-tight leading-tight font-bold headline-mark">
              The world's most hackable AI agent
            </h1>
            <ul className="text-lg sm:text-xl text-gray-600 mb-6 sm:mb-8 leading-relaxed space-y-2 list-disc pl-6">
              <li>multiplayer slack agent</li>
              <li>can use remote MCP servers</li>
              <li>customisable via rules in a git repo</li>
              <li>open source</li>
            </ul>
            <div className="mb-6 sm:mb-24 sm:flex sm:flex-col sm:items-end">
              <Button
                ref={addToSlackRef}
                className="w-full text-lg"
                size="lg"
                variant="secondary"
                onClick={handleAddToSlack}
              >
                <img src={slackIcon} alt="Slack" className="w-6 h-6 mr-2" />
                <span>Add to Slack</span>
              </Button>
              <p className="text-sm text-gray-500 mt-3 sm:text-right">
                or{" "}
                <button
                  onClick={() => setIsCalendarOpen(true)}
                  className="underline hover:text-gray-700"
                >
                  book a call with our team
                </button>
              </p>
            </div>
          </div>
          <div className="block lg:hidden mt-4 mb-8">
            <DisplayCards />
          </div>
          <div className="hidden lg:block">
            <DisplayCards />
          </div>
        </div>

        {/* Pricing section */}
        <section className="mt-20 mb-20" id="pricing">
          <h2 className="text-2xl font-bold mb-8">Super simple pricing</h2>
          <div className="max-w-3xl">
            <div className="border border-black p-8 bg-white">
              <div className="text-3xl font-bold mb-6">Raw token cost + 50%</div>
              <div className="space-y-4 text-gray-700">
                <p className="text-lg">
                  <strong>$50 free usage per month</strong> during beta
                </p>
                <p>Charged at the end of each month. No surprises, no hidden fees.</p>
                <div className="mt-6 pt-6 border-t border-gray-200">
                  <p className="text-sm text-gray-600">
                    <strong>Why we think this is fair:</strong> You can see all the tokens and
                    traces yourself. You have full control over the system prompt, so if you think
                    we're not being economical with tokens, you can customize it however you like.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

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
                <strong>Cursor rules for the entire company:</strong> Add rules and tools in your
                own GitHub repository (see our{" "}
                <a
                  href="https://github.com/iterate-com/estate-template"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-gray-900"
                >
                  template repo
                </a>{" "}
                or{" "}
                <a
                  href="https://github.com/iterate/iterate/tree/main/estates/iterate"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-gray-900"
                >
                  iterate's own iterate repo
                </a>
                ).
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
