interface AnimationPosition {
  z: number;
  x: number;
  y: number;
  rotate: number;
  opacity: number;
}

export const getStackedCardPositions = (count: number = 3): AnimationPosition[] => {
  return Array.from({ length: count }, (_, i) => ({
    z: 30 - (i * 10),
    x: i * 15,
    y: i * 8,
    rotate: i * 0.5,
    opacity: 1 - (i * 0.05)
  }));
};

export const getCardStackPositions = (): AnimationPosition[] => [
  { z: 30, x: 0, y: 0, rotate: 0, opacity: 1 },
  { z: 20, x: 15, y: 8, rotate: 0.5, opacity: 0.95 },
  { z: 10, x: 30, y: 16, rotate: 1, opacity: 0.9 }
];