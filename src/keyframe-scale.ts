export type ScaleKeyframe = { time: number; subjectScale?: number };

export const frameAt = (time: number, fps: number) => Math.floor(time * fps + 1e-6);

// Local corrections blend between keys and return to the global scale outside them.
export function scaleAt(time: number, fps: number, keys: ScaleKeyframe[], baseline: number) {
  if (!keys.length) return baseline;
  const frame = frameAt(time, fps);
  const sorted = [...keys].sort((a, b) => a.time - b.time);
  const right = sorted.findIndex(k => frameAt(k.time, fps) > frame);
  const window = Math.max(1, Math.round(fps * 1.5));
  if (right === 0) {
    const first = sorted[0];
    return baseline + ((first.subjectScale ?? baseline) - baseline) * Math.max(0, 1 - (frameAt(first.time, fps) - frame) / window);
  }
  if (right === -1) {
    const last = sorted[sorted.length - 1];
    return baseline + ((last.subjectScale ?? baseline) - baseline) * Math.max(0, 1 - (frame - frameAt(last.time, fps)) / window);
  }
  const a = sorted[right - 1], b = sorted[right];
  const t = (frame - frameAt(a.time, fps)) / (frameAt(b.time, fps) - frameAt(a.time, fps));
  return (a.subjectScale ?? baseline) * (1 - t) + (b.subjectScale ?? baseline) * t;
}

// Bake local zoom into the exported box, preserving its center and the engine contract.
export function boxAtScale<T extends { x: number; y: number; w: number; h: number }>(box: T, baseline: number, scale: number) {
  const w = box.w * baseline / scale, h = box.h * baseline / scale;
  return { ...box, x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, w, h };
}
