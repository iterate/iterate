import { useState } from "react";
import { motion } from "framer-motion";
import { cn } from "../utils/cn.ts";
import { Button } from "./Button.tsx";

interface Investor {
  name: string;
  role: string;
  url?: string;
  visible?: boolean;
}

export default function Investors() {
  const pageSize = 12;
  const allInvestors: Investor[] = [
    { name: "OpenAI", role: "Research Lab", url: "https://openai.com" },
    {
      name: "Index Ventures",
      role: "Carlos Gonzales-Cadenas",
      url: "https://indexventures.com/team/carlos-gonzalez-cadenas",
    },
    { name: "Lachy Groom", role: "LFG Fund", url: "https://twitter.com/lachygroom" },
    { name: "Max Mullen", role: "Co-founder of Instacart", url: "https://www.instacart.com" },
    { name: "Amjad Masad", role: "CEO of Replit", url: "https://replit.com" },
    { name: "Aravind Srinivas", role: "CEO of Perplexity.ai", url: "https://perplexity.ai" },
    { name: "Balaji Srinivasan", role: "Former CTO of Coinbase", url: "https://balajis.com" },
    { name: "Garry Tan", role: "CEO of Y Combinator", url: "https://ycombinator.com" },
    { name: "Naval Ravikant", role: "Co-founder of AngelList", url: "https://angel.co" },
    { name: "Arthur Mensch", role: "CEO of Mistral", url: "https://www.cradle.com" },
    { name: "Tom Brown", role: "Co-founder of Anthropic", url: "https://www.anthropic.com" },

    // alphabetical below
    { name: "Accel", role: "Sonali De Rycker" },
    { name: "Aidan Gomez", role: "CEO of Cohere", url: "https://www.cohere.ai" },
    { name: "Alex Bouaziz", role: "CEO of Deel", url: "https://www.letsdeel.com" },
    { name: "Alice Bentinck", role: "CEO of Entrepreneur First", url: "https://www.joinef.com" },
    { name: "Andrew Tan", role: "Tldr AI", url: "https://tldr.tech" },
    {
      name: "Anu Hariharan",
      role: "Founder of Avracap",
      url: "https://www.ycombinator.com/continuity",
    },
    { name: "Ben Firshman", role: "CEO of Replicate", url: "https://replicate.com" },
    { name: "Box Group", role: "David Tisch", url: "https://www.boxgroup.com" },
    {
      name: "Chi-Hua Chien",
      role: "Partner at Goodwater Capital",
      url: "https://www.goodwatercap.com",
    },
    { name: "Colin Sidoti", role: "CEO of Clerk", url: "https://www.clerk.com" },
    { name: "Darby Wong", role: "CEO of Clerky", url: "https://www.clerky.com" },
    { name: "Dave Ganly", role: "VP Product at Move.ai" },
    {
      name: "Eileen Burbidge",
      role: "Partner at Passion Capital",
      url: "https://www.passioncapital.com",
    },
    { name: "General Catalyst", role: "Adam Valkin", url: "https://www.generalcatalyst.com" },
    { name: "James Tamplin", role: "Co-founder of Firebase", url: "https://firebase.google.com" },
    { name: "Jamie Turner", role: "CEO of Convex", url: "https://www.convex.com" },
    { name: "Jerry Liu", role: "CEO of LlamaIndex", url: "https://llamaindex.ai" },
    { name: "Jelle Prins", role: "Co-founder of Cradle", url: "https://www.cradle.com" },
    { name: "Julien Launey", role: "CEO of Adaptive", url: "https://www.adaptive-ml.com" },
    {
      name: "Matt Clifford",
      role: "Co-founder of Entrepreneur First",
      url: "https://www.joinef.com",
    },
    { name: "Mehdi Ghissassi", role: "Product Lead at DeepMind", url: "https://deepmind.com" },
    { name: "Mike Hudack", role: "CEO of Sling", url: "https://sling.com" },
    { name: "Miles Grimshaw", role: "Partner at Thrive Capital", url: "https://www.benchmark.com" },
    {
      name: "Nathalie McGrath",
      role: "Co-founder of The People Design House",
      url: "https://coinbase.com",
    },
    { name: "Olivier Pomel", role: "CEO of Datadog", url: "https://www.datadoghq.com" },
    { name: "Paul Coppelstone", role: "CEO of Supabase", url: "https://supabase.com" },
    { name: "Paul Forster", role: "Founder of Indeed", url: "https://www.indeed.com" },
    { name: "Riya Grover", role: "CEO at Sequence", url: "https://www.sequencehq.com/" },
    { name: "Sabrina Hahn", role: "Solo VC" },
    { name: "Shruti Challa", role: "CRO at Sonder", url: "https://www.sonder.com" },
    { name: "Soleio.vc", role: "Design Angel", url: "https://soleio.com" },
    { name: "Stephen Whitworth", role: "CEO of Incident.io", url: "https://incident.io" },
    { name: "Tom Blomfield", role: "Partner at Y Combinator", url: "https://monzo.com" },
  ];
  const [visibleCount, setVisibleCount] = useState(pageSize - 1);
  const [loadMore, setLoadMore] = useState(allInvestors.length > pageSize);

  const handleShowMoreInvestors = () => {
    const nextVisibleCount = visibleCount + pageSize;
    setVisibleCount(nextVisibleCount);
    if (nextVisibleCount >= allInvestors.length) {
      setLoadMore(false);
    }
  };
  return (
    <section id="investors">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 border border-dashed border-gray-300 overflow-hidden">
        {allInvestors.slice(0, visibleCount).map(({ name, role }, _index) => {
          return (
            <motion.div
              key={name}
              className={cn(
                "p-4 border-r border-b border-dashed border-gray-300 -mb-[1px]",
                "[&:nth-child(2n)]:border-r-0",
                "sm:[&:nth-child(2n)]:border-r sm:[&:nth-child(3n)]:border-r-0",
                "lg:[&:nth-child(3n)]:border-r lg:[&:nth-child(4n)]:border-r-0",
              )}
              initial={{ opacity: 0, translateY: -20 }}
              animate={{ opacity: 1, translateY: 0 }}
              transition={{ type: "spring", duration: 0.3, bounce: 0.4 }}
            >
              <div className="text-sm font-semibold text-gray-900">{name}</div>
              <div className="text-xs text-gray-600">{role}</div>
            </motion.div>
          );
        })}
        {loadMore && (
          <div
            className={cn(
              "p-4 border-r border-b border-dashed border-gray-300 -mb-[1px]",
              "[&:nth-child(2n)]:border-r-0",
              "sm:[&:nth-child(2n)]:border-r sm:[&:nth-child(3n)]:border-r-0",
              "lg:[&:nth-child(3n)]:border-r lg:[&:nth-child(4n)]:border-r-0",
            )}
          >
            <Button
              variant="ghost"
              size="sm"
              onClick={handleShowMoreInvestors}
              className="text-xs font-semibold p-0 h-auto"
              data-testid="more-investors"
            >
              Show more →
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
