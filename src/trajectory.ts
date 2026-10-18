type Box = { x: number; y: number; w: number; h: number };
export function smoothTrajectory(boxes: Box[], amount: number, breaks: number[] = []): Box[] {
  const boundaries = [...new Set(breaks)].filter(f => f > 0 && f < boxes.length).sort((a, b) => a - b);
  if (boundaries.length) {
    const points = [0, ...boundaries, boxes.length];
    return points.slice(0, -1).flatMap((start, i) => smoothTrajectory(boxes.slice(start, points[i + 1]), amount));
  }
  if (!boxes.length || amount <= 0) return boxes;
  let size = Math.floor(5 + amount / 92 * 56);
  if (size % 2 === 0) size++;
  const half = Math.floor(size / 2), sigma = 2 + amount / 92 * 18;
  const weights = Array.from({ length: size }, (_, i) => Math.exp(-((i - half) ** 2) / (2 * sigma ** 2)));
  return boxes.map((_, i) => {
    const result = { x: 0, y: 0, w: 0, h: 0 }; let total = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(boxes.length - 1, i + half); j++) {
      const weight = weights[j - i + half]; total += weight;
      for (const key of ['x', 'y', 'w', 'h'] as const) result[key] += boxes[j][key] * weight;
    }
    for (const key of ['x', 'y', 'w', 'h'] as const) result[key] /= total;
    return result;
  });
}
