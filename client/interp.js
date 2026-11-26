// Snapshot interpolation for online play. Pure so it is testable without a browser.
import { lerpAngle } from '../shared/rules.js';

const TELEPORT_JUMP_M = 3; // a bigger hop than this between snapshots is a teleport, not motion

export function blendSnapshots(a, b, k) {
  const before = new Map(a.players.map((p) => [p.id, p]));
  const players = b.players.map((pb) => {
    const pa = before.get(pb.id);
    if (!pa || !pa.placed || !pb.placed) return pb;
    if (Math.hypot(pb.x - pa.x, pb.z - pa.z) > TELEPORT_JUMP_M) return pb;
    return {
      ...pb,
      x: pa.x + (pb.x - pa.x) * k,
      y: pa.y + (pb.y - pa.y) * k,
      z: pa.z + (pb.z - pa.z) * k,
      yaw: lerpAngle(pa.yaw, pb.yaw, k),
    };
  });
  return { ...b, players, events: [] };
}

// buf: [{ at: ms, s: snapshot }] oldest first. Returns the state to draw at time `renderAt` (ms).
export function sampleBuffer(buf, renderAt) {
  if (buf.length === 0) return null;
  const last = buf[buf.length - 1];
  if (buf.length === 1 || renderAt >= last.at) return { ...last.s, events: [] };
  if (renderAt <= buf[0].at) return { ...buf[0].s, events: [] };
  for (let i = buf.length - 1; i >= 1; i--) {
    if (buf[i - 1].at <= renderAt) {
      const a = buf[i - 1];
      const b = buf[i];
      const span = b.at - a.at;
      return blendSnapshots(a.s, b.s, span > 0 ? (renderAt - a.at) / span : 1);
    }
  }
  return { ...last.s, events: [] };
}
