// Bot brain. Deterministic given the sim's rng. Runs inside the sim, so bots behave the same
// offline (in the browser) and on the server.
//
// Plan: pick an opponent to hit, aim at them, and size the power so that the hit leaves enough speed
// to carry them over the nearest edge on that line. Never plan a slide whose unobstructed end point is
// off the grid (unless the match has dragged on), and fall back to "go toward the middle".
import { clampPower, lerpAngle, normalizeYaw } from './rules.js';
import { edgeDistance, rayExitDistance } from './grid.js';

function decide(sim, p) {
  const { grid, cfg, rng } = sim;
  const r = cfg.DUCK_RADIUS_M;
  const reckless = sim.round > cfg.BOT_RECKLESS_AFTER_ROUND;
  // Two bots that both charge each other swap velocities head-on and nothing happens, forever.
  // So each bot only attacks on some rounds; on the others it repositions toward the middle.
  const attacking = sim.rng.next() < cfg.BOT_ATTACK_CHANCE;
  const cands = [];

  for (const q of sim.players) {
    if (!attacking || q === p || !q.alive || !q.placed) continue;
    const dx = q.x - p.x;
    const dz = q.z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-3) continue;
    const ux = dx / dist;
    const uz = dz / dist;
    const targetRoom = rayExitDistance(grid, q.x, q.z, ux, uz, 14); // how far the target must be pushed
    const contact = Math.max(0, dist - 2 * r);
    let D = contact + targetRoom * 1.15 + 0.3;
    if (!reckless) {
      const mySafe = rayExitDistance(grid, p.x, p.z, ux, uz, 40) - 0.2; // if I miss, my own end point must stay on the grid
      if (mySafe < contact + 0.4) continue;
      D = Math.min(D, mySafe);
    }
    D = Math.min(D, cfg.MAX_SLIDE_M);
    cands.push({ yaw: Math.atan2(ux, uz), D, score: targetRoom + 0.25 * dist + rng.range(0, 2.5) });
  }

  // Fallback: retreat to the middle if close to an edge, otherwise take the smallest step the power floor allows.
  // When this bot decided to attack and has a usable target, the fallback only wins if it is in edge danger.
  const cdist = Math.hypot(p.x, p.z);
  const nearEdge = edgeDistance(grid, p.x, p.z, 16, 6) < 2;
  const haveAttack = cands.length > 0;
  const fallbackScore = haveAttack ? (nearEdge && !reckless ? -1 : 1e6) : 0;
  if (cdist > 0.5) {
    cands.push({
      yaw: Math.atan2(-p.x, -p.z),
      D: nearEdge ? cdist * rng.range(0.6, 0.95) : cfg.MIN_POWER * cfg.MAX_SLIDE_M,
      score: fallbackScore,
    });
  } else {
    cands.push({ yaw: rng.range(-Math.PI, Math.PI), D: cfg.MIN_POWER * cfg.MAX_SLIDE_M, score: fallbackScore });
  }

  let best = cands[0];
  for (const c of cands) if (c.score < best.score) best = c;
  return {
    yaw: normalizeYaw(best.yaw + rng.range(-cfg.BOT_AIM_ERR_RAD, cfg.BOT_AIM_ERR_RAD)),
    power: clampPower(best.D / cfg.MAX_SLIDE_M + rng.range(-cfg.BOT_POWER_ERR, cfg.BOT_POWER_ERR), cfg),
  };
}

export function botBeginPlanning(sim, p, elapsed = 0) {
  const { rng, cfg } = sim;
  const plan = decide(sim, p);
  p.bot = {
    yaw: plan.yaw,
    power: plan.power,
    fromYaw: p.yaw,
    fromPower: p.power,
    t0: elapsed,
    lockAt: elapsed + rng.range(cfg.BOT_THINK_MIN_S, cfg.BOT_THINK_MAX_S),
  };
}

// Called every planning tick. Eases the bot's aim/power toward its plan so it looks like it is
// "thinking", then locks in.
export function botTick(sim, p, elapsed) {
  if (!p.bot) botBeginPlanning(sim, p, elapsed);
  const b = p.bot;
  if (p.locked) return;
  const span = Math.max(0.01, b.lockAt - b.t0);
  const k = Math.min(1, Math.max(0, (elapsed - b.t0) / span));
  p.yaw = lerpAngle(b.fromYaw, b.yaw, k);
  p.power = b.fromPower + (b.power - b.fromPower) * k;
  if (elapsed >= b.lockAt) {
    p.yaw = b.yaw;
    p.power = b.power;
    p.locked = true;
  }
}
