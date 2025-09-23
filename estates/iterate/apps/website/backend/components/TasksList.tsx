import { useState } from "react";
import { motion } from "framer-motion";
import { cn } from "../utils/cn.ts";
import EmailForm from "./EmailForm.tsx";

export default function TasksList() {
  const initialVisibleCount = 10;
  const pageSize = 12;
  const allTasks: { name: string; visible?: boolean }[] = [
    { name: "Work out corporate structure and set up" },
    { name: "Choose and configure accounting software" },
    { name: "Answer accounting questions at month end" },
    { name: "Choose and configure hiring software" },
    { name: "Choose and configure cap table software" },
    { name: "Set up and manage company social media profiles" },
    { name: "Keep track of important documents" },
    { name: "Make sure you get your R&D tax credits" },
    { name: "Set up share options scheme, including EMI scheme in the UK" },
    { name: "Work out how to hire people in your country and abroad" },
    { name: "Make it possible for employees to spend company money" },
    { name: "Set up bank account(s)" },
    { name: "Work out where to host your website" },
    { name: "Pick accounting firm" },
    { name: "Pay invoices" },
    { name: "Choose and configure HRIS" },
    { name: "Get a VAT number and file returns" },
    { name: "Get all the startup credits with cloud providers, foundation model labs and others" },
    { name: "Find a way to get one-off agreements (e.g. LOI, NDA, etc) set up and signed" },
    { name: "Approve payroll each month" },
    { name: "Order swag" },
    { name: "Set up a safe way to share secrets / credentials between employees" },
    { name: "Get a registered agent address" },
    { name: "Get a mail scanning physical address" },
    { name: "Get a company phone number" },
    { name: "Set up investor CRM and remember to send investor emails" },
    { name: "Configure a meeting recording bot and connect to knowledge base" },
    {
      name: "Onboard new employees (options board consent, add to cap table software, sign contract, add to HRIS, provision accounts)"
    },
    { name: "Set up shared mailboxes via Front or Google groups for the public to reach you" },
    { name: "Organize events and get-togethers at your office" },
    { name: "Create and maintain company knowledge base" },
    { name: "Automate weekly KPI reporting" },
    { name: "Track product metrics in dashboard" },
    { name: "Collect user feedback surveys" },
    { name: "Run NPS survey" },
    { name: "Manage legal document templates" },
    { name: "Renew domain names before expiry" },
    { name: "Monitor website uptime" },
    { name: "Backup production databases" },
    { name: "Rotate API keys" },
    { name: "Run security audits" },
    { name: "Manage SOC2 compliance tasks" },
    { name: "Get SOC2 compliant" },
    { name: "Register with ICO (Information Commissioner's Office) in the UK" },
    { name: "Fill out compliance forms when selling to large companies" },
    { name: "File annual returns" },
    { name: "Manage board meeting calendar and minutes" },
    { name: "Prepare investor update decks" },
    { name: "Get insurance (Directors & Officers, Public Liability, Cyber, etc.)" },
    { name: "Work out how to offer pensions and benefits" },
    { name: "Set up easy way to book travel with VAT business invoices" },
    { name: "Book team travel" },
    { name: "Manage customer contract renewals" },
    { name: "Track customer support tickets" },
    { name: "Send onboarding emails to new customers" },
    { name: "Manage churn follow-up workflows" },
    { name: "Automate social media posting schedule" },
    { name: "Monitor competitor news" },
    { name: "Collect and pay sales taxes" },
    { name: "Handle reimbursements for employees" },
    { name: "Track hardware assets" },
    { name: "Manage office lease and utilities" },
    { name: "Order office supplies automatically" },
    { name: "Schedule team performance reviews" },
    { name: "Track PTO balances" },
    { name: "File insurance renewals" },
    { name: "Manage data privacy requests (GDPR, CCPA)" },
    { name: "Maintain open source license inventory" },
    { name: "Conduct payroll audits" },
    { name: "Generate cap table snapshots for fundraising" },
    { name: "Track option vesting schedules" },
    { name: "Remind employees of expiring visas" },
    { name: "Manage vendor onboarding and contracts" },
    { name: "Automate credit card reconciliations" },
    { name: "Run background checks for new hires" },
    { name: "Track bug bounty reports" },
    { name: "Schedule penetration tests" },
    { name: "Automate release note publishing" },
    { name: "Monitor cloud cost spend and alerts" },
    { name: "Manage feature flag rollouts" },
    { name: "Track engineering on-call rotations" },
    { name: "Coordinate design assets and brand guidelines" }
  ];
  const [visibleCount, setVisibleCount] = useState(initialVisibleCount);
  const [loadMore, setLoadMore] = useState(allTasks.length > initialVisibleCount);

  const tasksToShow = allTasks.map((task, index) => ({ ...task, visible: index < visibleCount }));

  const handleShowMoreTasks = () => {
    const clicks = Math.floor((visibleCount - initialVisibleCount) / pageSize);
    let nextVisibleCount: number;

    if (clicks === 2) {
      nextVisibleCount = allTasks.length;
    } else {
      nextVisibleCount = Math.min(visibleCount + pageSize, allTasks.length);
    }

    setVisibleCount(nextVisibleCount);
    if (nextVisibleCount >= allTasks.length) {
      setLoadMore(false);
    }
  };

  const handleShowLessTasks = () => {
    setVisibleCount(initialVisibleCount);
    setLoadMore(true);
  };

  return (
    <section
      className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-x-2 gap-y-1 sm:gap-y-2 text-neutral-700"
      id="tasks-list"
    >
      {tasksToShow.map(({ name, visible }, index) => (
        <motion.div
          key={name}
          className={cn("py-2 sm:py-3 flex items-start", !visible && "hidden")}
          animate={visible ? { opacity: 1, translateY: 0 } : { opacity: 0, translateY: -40 }}
          transition={{ type: "spring", duration: 0.3, bounce: 0.4 }}
        >
          <span className="mr-2 mt-0.5 flex h-4 min-w-4 px-1 flex-shrink-0 items-center justify-center rounded-full bg-neutral-200 text-xs font-medium text-neutral-600">
            {index + 1}
          </span>
          <p className="text-sm text-neutral-700">{name}</p>
        </motion.div>
      ))}
      {loadMore && (
        <button
          type="button"
          data-testid="more-tasks"
          onClick={handleShowMoreTasks}
          className="col-span-full sm:col-span-1 text-center sm:text-left text-xs cursor-pointer font-semibold hover:bg-gray-100 p-3 pb-4 rounded text-blue-600 hover:underline transition-all duration-75"
        >
          {(() => {
            const clicks = Math.floor((visibleCount - initialVisibleCount) / pageSize);
            if (clicks === 0) {
              return "...and dozens more";
            } else if (clicks === 1) {
              return "...yes, even more";
            } else if (clicks === 2) {
              return "...keep going";
            } else {
              return "...nearly there";
            }
          })()}
        </button>
      )}
      {!loadMore && allTasks.length > initialVisibleCount && (
        <div className="col-span-full mt-6 space-y-6">
          <h3 className="text-lg font-semibold text-center text-neutral-800">
            Automate all of this and more...
          </h3>
          <EmailForm />
          <div className="flex justify-center">
            <button
              type="button"
              data-testid="less-tasks"
              onClick={handleShowLessTasks}
              className="sm:col-span-1 text-center sm:text-left text-xs cursor-pointer font-semibold hover:bg-gray-100 p-3 pb-4 rounded text-blue-600 hover:underline transition-all duration-75"
            >
              Show Less
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
