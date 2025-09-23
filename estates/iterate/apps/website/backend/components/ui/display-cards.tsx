import React, { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { cn } from "../../utils/cn";
import logoAsset from "../../assets/logo.svg?url";
import { DISPLAY_CARD_THREADS } from "../../constants/display-cards-data";
import { getCardStackPositions } from "../../utils/animation-positions";

interface ThreadProps {
  ask: string;
  reply: string;
  className?: string;
  showReply: boolean;
}

function formatSlackText(text: string): React.ReactNode {
  // Split by lines first to preserve formatting
  const lines = text.split("\n");

  return lines.map((line, lineIndex) => {
    // Split each line by @mentions and #channels (including hyphens)
    const parts = line.split(/(@[\w-]+|#[\w-]+)/g);

    const formattedLine = parts.map((part, partIndex) => {
      if (part.startsWith("@") || part.startsWith("#")) {
        return (
          <span
            key={`${lineIndex}-${partIndex}`}
            className="bg-gray-100 text-gray-700 px-1 py-0.5 rounded hover:bg-gray-200 transition-colors cursor-pointer"
          >
            {part}
          </span>
        );
      }
      return part;
    });

    // Add line break after each line except the last
    return (
      <React.Fragment key={lineIndex}>
        {formattedLine}
        {lineIndex < lines.length - 1 && <br />}
      </React.Fragment>
    );
  });
}

function TypingIndicator(): React.ReactElement {
  return (
    <div className="flex items-center gap-1.5">
      <motion.div
        className="h-4 w-12 bg-gray-300 rounded"
        animate={{
          opacity: [0.3, 0.6, 0.3],
        }}
        transition={{
          duration: 1.5,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />
      <motion.div
        className="h-4 w-20 bg-gray-300 rounded"
        animate={{
          opacity: [0.3, 0.6, 0.3],
        }}
        transition={{
          duration: 1.5,
          repeat: Infinity,
          delay: 0.2,
          ease: "easeInOut",
        }}
      />
      <motion.div
        className="h-4 w-8 bg-gray-300 rounded"
        animate={{
          opacity: [0.3, 0.6, 0.3],
        }}
        transition={{
          duration: 1.5,
          repeat: Infinity,
          delay: 0.4,
          ease: "easeInOut",
        }}
      />
    </div>
  );
}

function SlackThreadCard({ ask, reply, className, showReply }: ThreadProps): React.ReactElement {
  const [showTyping, setShowTyping] = useState(false);
  const [showMessage, setShowMessage] = useState(false);

  useEffect(() => {
    if (showReply) {
      // Reset states
      setShowTyping(false);
      setShowMessage(false);

      // Show typing indicator after a brief delay
      const typingTimeout = setTimeout(() => {
        setShowTyping(true);
      }, 800);

      // Replace typing indicator with message
      const messageTimeout = setTimeout(() => {
        setShowTyping(false);
        setShowMessage(true);
      }, 2200);

      return () => {
        clearTimeout(typingTimeout);
        clearTimeout(messageTimeout);
      };
    } else {
      setShowTyping(false);
      setShowMessage(false);
    }
  }, [showReply]);

  return (
    <div
      className={cn(
        "relative bg-white border border-dashed border-gray-300 w-[90vw] xs:w-[24rem] sm:w-[28rem] md:w-[30rem] lg:w-[38rem] h-[28rem] sm:h-[26rem] md:h-[28rem] lg:h-[25rem] px-4 sm:px-6 py-4 sm:py-5",
        className,
      )}
    >
      <div className="space-y-0 relative">
        <motion.div
          className="flex items-start gap-3 relative"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          <div className="relative">
            <div className="h-8 w-8 sm:h-9 sm:w-9 bg-gray-200 flex items-center justify-center flex-shrink-0">
              <span className="text-[10px] sm:text-xs font-bold text-gray-700">You</span>
            </div>
            <motion.div
              className="absolute left-[50%] top-[2rem] sm:top-[2.25rem] w-[2px] bg-gray-200 -translate-x-1/2"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: showReply ? 1 : 0, height: showReply ? "5.5rem" : 0 }}
              transition={{ duration: 0.3, delay: showReply ? 0.6 : 0 }}
            />
          </div>
          <div className="flex-1 pt-0.5">
            <div className="flex items-baseline gap-2 mb-1">
              <span className="text-sm font-bold text-gray-900">You</span>
              <span className="text-xs text-gray-500">12:34 PM</span>
            </div>
            <p className="text-sm sm:text-base leading-relaxed text-gray-900">
              {formatSlackText(ask)}
            </p>
            <motion.div
              className="flex items-center gap-3 mt-1"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.3, delay: 0.5 }}
            >
              <span className="text-lg">👀</span>
            </motion.div>
          </div>
        </motion.div>

        <div className="flex items-start gap-3 pt-4">
          <motion.div
            className="h-8 w-8 sm:h-9 sm:w-9 flex items-center justify-center flex-shrink-0 bg-white relative z-10"
            animate={{ opacity: showReply ? 1 : 0 }}
            transition={{ duration: 0.3, delay: showReply ? 0.8 : 0 }}
          >
            <img src={logoAsset} alt="Iterate" className="w-full h-full" />
          </motion.div>
          <div className="flex-1 pt-0.5">
            <motion.div
              className="flex items-baseline gap-2 mb-1"
              animate={{ opacity: showReply ? 1 : 0 }}
              transition={{ duration: 0.3, delay: showReply ? 0.8 : 0 }}
            >
              <span className="text-sm font-bold text-gray-900">iterate</span>
              <span className="px-1.5 py-0.5 bg-gray-100 text-gray-600 text-[10px] font-medium rounded">
                APP
              </span>
              <span className="text-xs text-gray-500">12:34 PM</span>
            </motion.div>
            <div className="min-h-[1.5rem]">
              <AnimatePresence mode="wait">
                {showTyping && (
                  <motion.div
                    key="typing"
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -5 }}
                    transition={{ duration: 0.2 }}
                  >
                    <TypingIndicator />
                  </motion.div>
                )}
                {showMessage && (
                  <motion.div
                    key="message"
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, ease: "easeOut" }}
                  >
                    <p className="text-sm sm:text-base leading-relaxed text-gray-900">
                      {formatSlackText(reply)}
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface DisplayCardsProps {
  threads?: Array<{ ask: string; reply: string }>;
}

export default function DisplayCards({
  threads = DISPLAY_CARD_THREADS,
}: DisplayCardsProps = {}): React.ReactElement {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [showReply, setShowReply] = useState(false);

  useEffect(() => {
    // Show first reply after initial delay
    const initialTimeout = setTimeout(() => setShowReply(true), 800);

    const cycleInterval = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % threads.length);
      setShowReply(false);
      setTimeout(() => setShowReply(true), 800);
    }, 8000); // Increased to 8 seconds per card

    return () => {
      clearInterval(cycleInterval);
      clearTimeout(initialTimeout);
    };
  }, [threads.length]);

  const positions = getCardStackPositions();

  // Calculate which threads to show
  const visibleThreads = positions.map((_, i) => {
    const threadIndex = (currentIndex + i) % threads.length;
    return threads[threadIndex];
  });

  return (
    <div className="relative grid [grid-template-areas:'stack'] place-items-center h-[30rem] sm:h-[28rem] md:h-[30rem] lg:h-[26rem] mx-auto max-w-full">
      {positions.map((pos, i) => {
        const thread = visibleThreads[i];
        const isTop = i === 0;

        return (
          <motion.div
            key={`${currentIndex}-${i}`}
            className="[grid-area:stack]"
            style={{ zIndex: positions[i].z }}
            animate={{
              x: pos.x,
              y: pos.y,
              rotate: pos.rotate,
              opacity: pos.opacity,
              scale: 1,
            }}
            transition={{
              type: "spring",
              stiffness: 300,
              damping: 30,
              mass: 1,
            }}
          >
            <SlackThreadCard
              ask={thread.ask}
              reply={thread.reply}
              showReply={isTop ? showReply : false}
            />
          </motion.div>
        );
      })}
    </div>
  );
}
