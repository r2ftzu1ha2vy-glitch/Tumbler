// Tumbler simulation. Pure: no DOM, no timers, no three.js. Runs in the browser (offline mode)
// and on the Node server (online rooms) from this one file.
//
// Match flow:
//   COUNTDOWN (5 s, nobody on the grid) -> everyone teleports to a random spot
//   PLANNING  (aim + power, lock in or timer) -> SLIDING (all ducks slide at once, can bump each other)
//   -> back to PLANNING while 2+ ducks are alive, else GAMEOVER.
// A duck whose centre leaves the grid footprint is out.
import { CONFIG } from './config.js';
import { edgeDistance, isOnGrid } from './grid.js';
import { createRng, randomSeed } from './rng.js';
import { aimDir, clampPower, launchSpeed, normalizeYaw, slideDistance } from './rules.js';
import { botBeginPlanning, botTick } from './bot.js';

export const PHASE = Object.freeze({
  COUNTDOWN: 'countdown',
  PLANNING: 'planning',
  SLIDING: 'sliding',
  GAMEOVER: 'gameover',
});

const BOT_NAMES = ['Bot Quackers', 'Bot Waddles', 'Bot Puddles', 'Bot Nugget', 'Bot Biscuit'];

// Humans first, then bots up to cfg.MAX_PLAYERS.
export function fillWithBots(humans, cfg = CONFIG) {
  const list = humans.slice(0, cfg.MAX_PLAYERS).map((h) => ({ id: h.id, name: h.name, isBot: false }));
  let i = 0;
  while (list.length < cfg.MAX_PLAYERS) {
    list.push({ id: `bot${i + 1}`, name: BOT_NAMES[i % BOT_NAMES.length], isBot: true });
    i++;
  }
  return list;
}

export function createSim({ grid, players, seed = randomSeed(), cfg = CONFIG }) {
  if (!Array.isArray(players) || players.length < 2) throw new Error('a match needs at least 2 players');
  const ids = new Set(players.map((p) => String(p.id)));
  if (ids.size !== players.length) throw new Error('player ids must be unique');
  const sim = {
    cfg,
    grid,
    rng: createRng(seed),
    seed,
    phase: PHASE.COUNTDOWN,
    timer: cfg.COUNTDOWN_S,
    round: 0,
    time: 0,
    acc: 0,
    slideTime: 0,
    winnerId: null,
    events: [],
    players: players.map((p, i) => ({
      id: String(p.id),
      name: String(p.name).slice(0, 16),
      isBot: !!p.isBot,
      ci: i,
      alive: true,
      placed: false,
      gone: false,
      locked: false,
      x: 0,
      y: grid.top,
      z: 0,
      vx: 0,
      vz: 0,
      vy: 0,
      yaw: 0,
      power: cfg.DEFAULT_POWER,
      fellAt: -1,
      bot: null,
    })),
  };
  sim.events.push({ type: 'phase', phase: sim.phase, round: 0 });
  return sim;
}

export function aliveCount(sim) {
  let n = 0;
  for (const p of sim.players) if (p.alive) n++;
  return n;
}

// Called when a human leaves mid-match: a bot takes the duck over.
export function convertToBot(sim, id) {
  const p = sim.players.find((q) => q.id === id);
  if (!p) return false;
  p.isBot = true;
  p.bot = null;
  return true;
}

// Human input. Only accepted while planning, for a living human duck. Non-finite numbers are rejected.
export function applyInput(sim, id, input) {
  const p = sim.players.find((q) => q.id === id);
  if (!p || p.isBot || !p.alive || sim.phase !== PHASE.PLANNING) return false;
  if (!input || typeof input !== 'object') return false;
  if (typeof input.power === 'number' && Number.isFinite(input.power)) p.power = clampPower(input.power, sim.cfg);
  if (typeof input.yaw === 'number' && Number.isFinite(input.yaw)) p.yaw = normalizeYaw(input.yaw);
  if (typeof input.lock === 'boolean') p.locked = input.lock;
  return true;
}

// Advance by real elapsed seconds; steps the fixed tick as many times as fit.
export function advance(sim, dt) {
  if (!(dt > 0) || !Number.isFinite(dt)) return;
  sim.acc += Math.min(dt, 0.25);
  const h = 1 / sim.cfg.TICK_HZ;
  while (sim.acc >= h) {
    tick(sim, h);
    sim.acc -= h;
  }
}

function tick(sim, h) {
  const { cfg, grid } = sim;
  sim.time += h;

  // Ducks that already left the grid keep falling in every phase.
  for (const p of sim.players) {
    if (p.alive || !p.placed || p.gone) continue;
    p.vy -= cfg.GRAVITY_MPS2 * h;
    p.y += p.vy * h;
    p.x += p.vx * h;
    p.z += p.vz * h;
    if (p.y < grid.top - cfg.FALL_KILL_DEPTH_M) p.gone = true;
  }

  switch (sim.phase) {
    case PHASE.COUNTDOWN:
      sim.timer -= h;
      if (sim.timer <= 0) {
        teleportAll(sim);
        beginPlanning(sim);
      }
      break;
    case PHASE.PLANNING: {
      sim.timer -= h;
      const elapsed = cfg.PLAN_TIME_S - sim.timer;
      let everyoneLocked = true;
      for (const p of sim.players) {
        if (!p.alive) continue;
        if (p.isBot) botTick(sim, p, elapsed);
        if (!p.locked) everyoneLocked = false;
      }
      if (everyoneLocked || sim.timer <= 0) beginSliding(sim);
      break;
    }
    case PHASE.SLIDING:
      slideStep(sim, h);
      break;
    default:
      break;
  }
}

function setPhase(sim, phase, timer) {
  sim.phase = phase;
  if (timer !== undefined) sim.timer = timer;
  sim.events.push({ type: 'phase', phase, round: sim.round });
}

function beginPlanning(sim) {
  sim.round++;
  setPhase(sim, PHASE.PLANNING, sim.cfg.PLAN_TIME_S);
  for (const p of sim.players) {
    if (!p.alive) continue;
    p.locked = false;
    p.vx = 0;
    p.vz = 0;
    p.bot = null;
    if (p.isBot) botBeginPlanning(sim, p, 0);
  }
}

function beginSliding(sim) {
  setPhase(sim, PHASE.SLIDING);
  sim.slideTime = 0;
  for (const p of sim.players) {
    if (!p.alive) continue;
    const dir = aimDir(p.yaw);
    const v0 = launchSpeed(slideDistance(p.power, sim.cfg), sim.cfg);
    p.vx = dir.x * v0;
    p.vz = dir.z * v0;
  }
  sim.events.push({ type: 'launch' });
}

function slideStep(sim, h) {
  const { cfg, grid } = sim;
  sim.slideTime += h;

  for (const p of sim.players) {
    if (!p.alive) continue;
    const speed = Math.hypot(p.vx, p.vz);
    if (speed > 0) {
      const ns = Math.max(0, speed - cfg.FRICTION_MPS2 * h);
      const k = ns / speed;
      p.vx *= k;
      p.vz *= k;
    }
    p.x += p.vx * h;
    p.z += p.vz * h;
  }

  collide(sim);

  for (const p of sim.players) {
    if (!p.alive) continue;
    if (!isOnGrid(grid, p.x, p.z)) {
      p.alive = false;
      p.locked = false;
      p.fellAt = sim.time;
      p.vy = 0;
      sim.events.push({ type: 'fall', id: p.id, x: p.x, z: p.z });
    }
  }

  let moving = false;
  for (const p of sim.players) {
    if (p.alive && Math.hypot(p.vx, p.vz) > cfg.SETTLE_SPEED_MPS) moving = true;
  }
  if (!moving || sim.slideTime > cfg.SLIDE_MAX_S) {
    for (const p of sim.players) {
      if (p.alive) {
        p.vx = 0;
        p.vz = 0;
      }
    }
    endSlide(sim);
  }
}

function collide(sim) {
  const { cfg } = sim;
  const reach = 2 * cfg.DUCK_RADIUS_M;
  const ps = sim.players.filter((p) => p.alive && p.placed);
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i];
      const b = ps[j];
      const dx = b.x - a.x;
      const dz = b.z - a.z;
      const d2 = dx * dx + dz * dz;
      if (d2 >= reach * reach) continue;
      let d = Math.sqrt(d2);
      let nx = 1;
      let nz = 0;
      if (d > 1e-6) {
        nx = dx / d;
        nz = dz / d;
      } else {
        d = 0;
      }
      const push = (reach - d) / 2;
      a.x -= nx * push;
      a.z -= nz * push;
      b.x += nx * push;
      b.z += nz * push;
      const closing = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
      if (closing > 0) {
        const j2 = ((1 + cfg.RESTITUTION) * closing) / 2; // equal masses
        a.vx -= j2 * nx;
        a.vz -= j2 * nz;
        b.vx += j2 * nx;
        b.vz += j2 * nz;
        if (closing > 0.5) sim.events.push({ type: 'bump', x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, speed: closing });
      }
    }
  }
}

function endSlide(sim) {
  const alive = sim.players.filter((p) => p.alive);
  if (alive.length >= 2) {
    beginPlanning(sim);
    return;
  }
  if (alive.length === 1) {
    sim.winnerId = alive[0].id;
  } else {
    // Everyone fell: the duck that fell last outlasted the rest. A tie on the same tick is a draw.
    let best = null;
    let tie = false;
    for (const p of sim.players) {
      if (p.fellAt < 0) continue;
      if (best === null || p.fellAt > best.fellAt + 1e-9) {
        best = p;
        tie = false;
      } else if (Math.abs(p.fellAt - best.fellAt) <= 1e-9) {
        tie = true;
      }
    }
    sim.winnerId = best && !tie ? best.id : null;
  }
  setPhase(sim, PHASE.GAMEOVER, 0);
  sim.events.push({ type: 'gameover', winnerId: sim.winnerId });
}

function randomPointOnGrid(sim) {
  const tiles = sim.grid.tiles;
  let total = 0;
  for (const t of tiles) total += t.hx * t.hz;
  let pick = sim.rng.next() * total;
  let tile = tiles[tiles.length - 1];
  for (const t of tiles) {
    pick -= t.hx * t.hz;
    if (pick <= 0) {
      tile = t;
      break;
    }
  }
  return {
    x: tile.cx + (sim.rng.next() * 2 - 1) * tile.hx,
    z: tile.cz + (sim.rng.next() * 2 - 1) * tile.hz,
  };
}

function pickSpawn(sim, placed) {
  const { cfg, grid } = sim;
  let sep = cfg.SPAWN_MIN_SEPARATION_M;
  for (let relax = 0; relax < 6; relax++) {
    for (let i = 0; i < 200; i++) {
      const c = randomPointOnGrid(sim);
      if (edgeDistance(grid, c.x, c.z, 16, cfg.SPAWN_EDGE_MARGIN_M + 0.5) < cfg.SPAWN_EDGE_MARGIN_M) continue;
      if (placed.every((q) => Math.hypot(q.x - c.x, q.z - c.z) >= sep)) return c;
    }
    sep /= 2;
  }
  return randomPointOnGrid(sim);
}

function teleportAll(sim) {
  const placed = [];
  for (const p of sim.players) {
    if (!p.alive || p.placed) continue;
    const c = pickSpawn(sim, placed);
    placed.push(c);
    p.x = c.x;
    p.z = c.z;
    p.y = sim.grid.top;
    p.yaw = Math.atan2(-c.x, -c.z); // start facing the middle of the grid
    p.placed = true;
    sim.events.push({ type: 'teleport', id: p.id, x: p.x, z: p.z, yaw: p.yaw });
  }
}

const r3 = (v) => Math.round(v * 1000) / 1000;

// JSON-safe view of the match. Drains the pending event list into the returned object.
export function snapshot(sim) {
  const events = sim.events;
  sim.events = [];
  return {
    phase: sim.phase,
    timer: Math.max(0, r3(sim.timer)),
    round: sim.round,
    planTime: sim.cfg.PLAN_TIME_S,
    winnerId: sim.winnerId,
    events,
    players: sim.players.map((p) => ({
      id: p.id,
      name: p.name,
      isBot: p.isBot,
      ci: p.ci,
      alive: p.alive,
      placed: p.placed,
      gone: p.gone,
      locked: p.locked,
      x: r3(p.x),
      y: r3(p.y),
      z: r3(p.z),
      vx: r3(p.vx),
      vz: r3(p.vz),
      yaw: r3(p.yaw),
      power: r3(p.power),
    })),
  };
}
