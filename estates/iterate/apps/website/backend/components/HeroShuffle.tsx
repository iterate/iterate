import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";

interface CardInfo {
  title: string;
  body: string;
}

const CARDS: CardInfo[] = [
  {
    title: "GitHub ↔ Linear",
    body: "When code lands, tickets move. Keep labels and status in sync without thinking about it."
  },
  {
    title: "Notion",
    body: "Drop notes and tasks into your databases. Get a short summary back in the channel."
  },
  {
    title: "Add tools fast",
    body: "Paste an MCP server URL to try a new tool. No waiting for a product update."
  }
];

export default function HeroShuffle() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % CARDS.length), 2600);
    return () => clearInterval(id);
  }, []);

  const order = useMemo(() => {
    // rotate array so the "front" card changes over time
    return [0, 1, 2].map((i) => CARDS[(i + index) % CARDS.length]);
  }, [index]);

  const layers = [
    { z: 30, tx: 0, ty: 0, r: 0, s: 1 },
    { z: 20, tx: 16, ty: 16, r: -4, s: 0.985 },
    { z: 10, tx: 32, ty: 32, r: 5, s: 0.97 }
  ];

  return (
    <div
      aria-hidden
      className="relative w-full h-72 md:h-80 lg:h-96 select-none"
    >
      {order.map((card, i) => (
        <motion.div
          key={card.title}
          className="absolute top-0 left-0 right-10 brutal-card brutal-dots bg-white"
          style={{ zIndex: layers[i].z }}
          animate={{
            x: layers[i].tx,
            y: layers[i].ty,
            rotate: layers[i].r,
            scale: layers[i].s
          }}
          transition={{ type: "spring", stiffness: 120, damping: 18 }}
        >
          <div className="p-5">
            <h3 className="text-base font-semibold mb-2">{card.title}</h3>
            <p className="text-sm text-gray-600 leading-relaxed">{card.body}</p>
          </div>
        </motion.div>
      ))}
    </div>
  );
}
