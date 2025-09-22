import React, { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";

interface CalendarModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function CalendarModal({ isOpen, onClose }: CalendarModalProps): React.ReactElement | null {
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    
    if (isOpen) {
      window.addEventListener('keydown', handleEscape);
      return () => window.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen, onClose]);

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            className="fixed inset-0 bg-black/50 z-40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            className="fixed inset-2 sm:inset-4 md:inset-auto md:left-1/2 md:top-1/2 md:-translate-x-1/2 md:-translate-y-1/2 z-50 bg-white border-2 border-black md:max-w-3xl md:w-[90vw] max-h-[95vh] sm:max-h-[90vh] md:max-h-[85vh] md:h-[700px] overflow-hidden flex flex-col"
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.2 }}
          >
            <div className="p-3 sm:p-4 md:p-6 border-b-2 border-black flex items-center justify-between flex-shrink-0">
              <h2 className="text-lg sm:text-xl md:text-2xl font-bold pr-4">Book a free installation</h2>
              <button
                onClick={onClose}
                className="p-1.5 sm:p-2 hover:bg-gray-100 transition-colors flex-shrink-0"
                aria-label="Close modal"
              >
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path d="M15 5L5 15M5 5L15 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
            <div className="flex-1 overflow-auto">
              <iframe 
                src="https://calendar.google.com/calendar/appointments/schedules/AcZssZ0ZUOvd7qjmRVELvPy9FJThcKjdCYncMyKfIM3gvAihHboY0snFMCu0Kv0Il1dkQTgWgWHyb4gd?gv=true" 
                style={{ border: 0 }} 
                width="100%" 
                height="100%" 
                frameBorder="0"
                title="Book an appointment"
              />
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}