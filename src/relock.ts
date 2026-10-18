export type Box = { x: number; y: number; w: number; h: number };
export type PositionKey = { time: number; box: Box; position?: boolean; positionEnd?: number };

// A new identity segment replaces the future, preserving edits before its boundary.
export function mergeRelock(previous: Box[], next: Box[], frame: number): Box[] {
  if (previous.length !== next.length || frame < 0 || frame >= next.length) {
    throw new Error("重新锁定的轨迹长度不匹配，请重新分析整段视频。");
  }
  return [...previous.slice(0, frame), ...next.slice(frame)];
}

export function retirePositionKeys<T extends PositionKey>(keys: T[], frame: number, fps: number): T[] {
  return keys.map(key => Math.round(key.time * fps) < frame
    ? { ...key, positionEnd: Math.min(key.positionEnd ?? Infinity, frame) }
    : { ...key, position: false });
}

export function positionKeysAt<T extends PositionKey>(keys: T[], frame: number): T[] {
  return keys.filter(key => key.position !== false && frame < (key.positionEnd ?? Infinity));
}
