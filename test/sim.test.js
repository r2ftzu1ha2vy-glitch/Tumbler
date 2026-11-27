import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlbJson, gridFromGltfJson, lobbyFromGltfJson } from '../shared/glb.js';
import { ASSETS, CONFIG } from '../shared/config.js';
import { isOnGrid, edgeDistance } from '../shared/grid.js';
import { PHASE, advance, applyInput, createSim, fillWithBots, snapshot, aliveCount, convertToBot } from '../shared/sim.js';
import { slideDistance, launchSpeed, quantizePower, powerToLevel } from '../shared/rules.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const grid = gridFromGltfJson(readGlbJson(fs.readFileSync(path.join(root, 'assets', 'Grid.glb'))));
const lobby = lobbyFromGltfJson(readGlbJson(fs.readFileSync(path.join(root, 'assets', 'Lobby.glb'))), ASSETS.LOBBY_SPAWN_NODE);

// A huge flat grid for measuring slide distance without falling off.
const bigGrid = { tiles: [{ cx: 0, cz: 0, hx: 500, hz: 500, top: 1.15 }], top: 1.15 };
const humans = (n) => Array.from({ length: n }, (_, i) => ({ id: `h${i + 1}`, name: `P${i + 1}` }));
const run = (sim, seconds) => {
  for (let i = 0; i < Math.round(seconds * 60); i++) advance(sim, 1 / 60);
};

// Put a sim into PLANNING with two ducks at chosen spots (bypasses the random teleport).
function planned({ g = grid, spots, seed = 1 }) {
  const sim = createSim({ grid: g, players: spots.map((s, i) => ({ id: `h${i + 1}`, name: `P${i + 1}` })), seed });
  run(sim, CONFIG.COUNTDOWN_S + 0.05);
  assert.equal(sim.phase, PHASE.PLANNING);
  spots.forEach((s, i) => Object.assign(sim.players[i], { x: s.x, z: s.z }));
  return sim;
}

test('countdown lasts 5 s, then everyone is teleported onto the grid', () => {
  const sim = createSim({ grid, players: fillWithBots(humans(1)), seed: 7 });
  run(sim, 4.9);
  assert.equal(sim.phase, PHASE.COUNTDOWN);
  assert.ok(sim.players.every((p) => !p.placed));
  run(sim, 0.2);
  assert.equal(sim.phase, PHASE.PLANNING);
  assert.ok(sim.players.every((p) => p.placed));
  for (const p of sim.players) {
    assert.ok(isOnGrid(grid, p.x, p.z));
    assert.ok(edgeDistance(grid, p.x, p.z, 16, 3) >= CONFIG.SPAWN_EDGE_MARGIN_M - 1e-9);
  }
  for (let i = 0; i < 5; i++) {
    for (let j = i + 1; j < 5; j++) {
      const a = sim.players[i];
      const b = sim.players[j];
      assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= CONFIG.SPAWN_MIN_SEPARATION_M - 1e-9);
    }
  }
});

test('teleport spots are random across seeds', () => {
  const firsts = new Set();
  for (let seed = 1; seed <= 20; seed++) {
    const sim = createSim({ grid, players: fillWithBots(humans(1)), seed });
    run(sim, 5.1);
    firsts.add(`${sim.players[0].x.toFixed(2)},${sim.players[0].z.toFixed(2)}`);
  }
  assert.ok(firsts.size >= 18);
});

test('power maps to slide distance (unobstructed)', () => {
  for (const power of [0.1, 0.5, 1]) {
    const sim = planned({ g: bigGrid, spots: [{ x: 0, z: 0 }, { x: 400, z: 400 }] });
    applyInput(sim, 'h1', { power, yaw: 0, lock: true });
    applyInput(sim, 'h2', { power: 0.1, yaw: 0, lock: true });
    advance(sim, 1 / 60);
    assert.equal(sim.phase, PHASE.SLIDING);
    run(sim, 6);
    const want = slideDistance(power);
    assert.ok(Math.abs(sim.players[0].z - want) / want < 0.03, `power ${power}: slid ${sim.players[0].z}, wanted ${want}`);
    assert.ok(Math.abs(sim.players[0].x) < 1e-9, 'yaw 0 must slide along +Z');
  }
});

test('yaw convention: positive yaw slides toward +X', () => {
  const sim = planned({ g: bigGrid, spots: [{ x: 0, z: 0 }, { x: 400, z: 400 }] });
  applyInput(sim, 'h1', { power: 0.5, yaw: Math.PI / 2, lock: true });
  applyInput(sim, 'h2', { lock: true });
  run(sim, 6);
  assert.ok(sim.players[0].x > 6.5 && Math.abs(sim.players[0].z) < 1e-6);
});

test('input is validated: NaN rejected, power clamped, ignored outside planning', () => {
  const sim = planned({ spots: [{ x: -3, z: 0 }, { x: 3, z: 0 }] });
  const before = sim.players[0].power;
  applyInput(sim, 'h1', { power: NaN, yaw: Infinity });
  assert.equal(sim.players[0].power, before);
  applyInput(sim, 'h1', { power: 9 });
  assert.equal(sim.players[0].power, 1);
  applyInput(sim, 'h1', { power: -3 });
  assert.equal(sim.players[0].power, CONFIG.MIN_POWER);
  assert.equal(applyInput(sim, 'nobody', { power: 0.5 }), false);
  applyInput(sim, 'h1', { lock: true });
  applyInput(sim, 'h2', { lock: true });
  advance(sim, 1 / 60);
  assert.equal(sim.phase, PHASE.SLIDING);
  assert.equal(applyInput(sim, 'h1', { power: 0.9 }), false);
});

test('planning timer forces the slide when nobody locks', () => {
  const sim = planned({ spots: [{ x: -3, z: 0 }, { x: 3, z: 0 }] });
  run(sim, CONFIG.PLAN_TIME_S - 0.2);
  assert.equal(sim.phase, PHASE.PLANNING);
  run(sim, 0.4);
  assert.equal(sim.phase, PHASE.SLIDING);
});

test('sliding off the edge eliminates the duck; last alive wins', () => {
  const sim = planned({ spots: [{ x: 0, z: 6 }, { x: 0, z: -6 }] });
  applyInput(sim, 'h1', { power: 0.6, yaw: 0, lock: true }); // +Z, off the 7.5 edge
  applyInput(sim, 'h2', { power: 0.1, yaw: Math.PI, lock: true }); // -Z, 1.4 m: -6 -> -7.4, stays on
  run(sim, 6);
  assert.equal(sim.phase, PHASE.GAMEOVER);
  assert.equal(sim.players[0].alive, false);
  assert.equal(sim.players[1].alive, true);
  assert.equal(sim.winnerId, 'h2');
});

test('a fallen duck keeps falling and is eventually gone', () => {
  const sim = planned({ spots: [{ x: 0, z: 7 }, { x: 0, z: -3 }] });
  applyInput(sim, 'h1', { power: 0.5, yaw: 0, lock: true });
  applyInput(sim, 'h2', { power: 0.1, yaw: Math.PI, lock: true });
  run(sim, 1);
  const p = sim.players[0];
  assert.equal(p.alive, false);
  assert.ok(p.y < grid.top);
  run(sim, 6);
  assert.equal(sim.players[0].gone, true);
});

test('both fall on the same tick -> draw; falling at different times -> later one wins', () => {
  const draw = planned({ spots: [{ x: 7, z: 0 }, { x: -7, z: 0 }] });
  applyInput(draw, 'h1', { power: 0.5, yaw: Math.PI / 2, lock: true });
  applyInput(draw, 'h2', { power: 0.5, yaw: -Math.PI / 2, lock: true });
  run(draw, 6);
  assert.equal(draw.phase, PHASE.GAMEOVER);
  assert.equal(draw.winnerId, null);

  const late = planned({ spots: [{ x: 7, z: 0 }, { x: 0, z: 5 }] });
  applyInput(late, 'h1', { power: 0.5, yaw: Math.PI / 2, lock: true }); // falls almost at once
  applyInput(late, 'h2', { power: 1, yaw: 0, lock: true }); // falls later
  run(late, 6);
  assert.equal(late.winnerId, 'h2');
});

test('head-on bump: equal masses exchange velocity, total momentum conserved', () => {
  const sim = planned({ g: bigGrid, spots: [{ x: -2, z: 0 }, { x: 2, z: 0 }] });
  applyInput(sim, 'h1', { power: 0.3, yaw: Math.PI / 2, lock: true }); // toward +X
  applyInput(sim, 'h2', { power: 0.01, yaw: 0, lock: true }); // clamped to MIN_POWER, slides along +Z
  // make duck 2 stationary-ish: set it to 0 launch by hand after the slide starts
  advance(sim, 1 / 60);
  sim.players[1].vx = 0;
  sim.players[1].vz = 0;
  let maxP = 0;
  let hit = false;
  for (let i = 0; i < 600 && !hit; i++) {
    const pBefore = sim.players[0].vx + sim.players[1].vx;
    advance(sim, 1 / 60);
    if (sim.players[1].vx > 0.5) {
      hit = true;
      const pAfter = sim.players[0].vx + sim.players[1].vx;
      maxP = Math.abs(pAfter - pBefore);
    }
  }
  assert.ok(hit, 'duck 2 never got pushed');
  assert.ok(maxP < 0.2, `momentum jumped by ${maxP}`);
});

test('ducks never overlap deeper than a hair after resolution', () => {
  const sim = planned({ g: bigGrid, spots: [{ x: -1, z: 0 }, { x: 1, z: 0 }] });
  applyInput(sim, 'h1', { power: 1, yaw: Math.PI / 2, lock: true });
  applyInput(sim, 'h2', { power: 1, yaw: -Math.PI / 2, lock: true });
  for (let i = 0; i < 300; i++) {
    advance(sim, 1 / 60);
    const d = Math.hypot(sim.players[0].x - sim.players[1].x, sim.players[0].z - sim.players[1].z);
    assert.ok(d >= 2 * CONFIG.DUCK_RADIUS_M - 1e-6, `overlap at tick ${i}: ${d}`);
  }
});

test('same seed + same inputs = identical match', () => {
  const play = () => {
    const sim = createSim({ grid, players: fillWithBots(humans(2)), seed: 4242 });
    const log = [];
    for (let i = 0; i < 60 * 40; i++) {
      advance(sim, 1 / 60);
      if (i === 60 * 7) {
        applyInput(sim, 'h1', { yaw: 0.3, power: 0.7, lock: true });
        applyInput(sim, 'h2', { yaw: -0.3, power: 0.4, lock: true });
      }
      if (i % 30 === 0) log.push(JSON.stringify(snapshot(sim)));
    }
    return log.join('\n');
  };
  assert.equal(play(), play());
});

test('fillWithBots fills to 5 and never exceeds it', () => {
  for (let n = 1; n <= 5; n++) {
    const list = fillWithBots(humans(n));
    assert.equal(list.length, 5);
    assert.equal(list.filter((p) => !p.isBot).length, n);
    assert.equal(new Set(list.map((p) => p.id)).size, 5);
  }
  assert.equal(fillWithBots(humans(8)).length, 5);
});

test('a human who leaves is replaced by a bot and the match still finishes', () => {
  const sim = createSim({ grid, players: fillWithBots(humans(2)), seed: 99 });
  run(sim, 6);
  convertToBot(sim, 'h2');
  assert.equal(applyInput(sim, 'h2', { power: 0.5 }), false);
  run(sim, 60 * 4);
  assert.ok(sim.round >= 1);
});

test('bot-only matches always finish, and bots do not all kill themselves instantly', () => {
  let finished = 0;
  const rounds = [];
  for (let seed = 1; seed <= 150; seed++) {
    const sim = createSim({ grid, players: fillWithBots([]).map((p) => ({ ...p, isBot: true })), seed });
    for (let t = 0; t < 60 * 60 * 6 && sim.phase !== PHASE.GAMEOVER; t++) advance(sim, 1 / 60);
    if (sim.phase === PHASE.GAMEOVER) {
      finished++;
      rounds.push(sim.round);
    }
  }
  assert.equal(finished, 150, 'some bot-only matches never ended');
  const avg = rounds.reduce((a, b) => a + b, 0) / rounds.length;
  console.log(`  bot-only: 150/150 finished, avg ${avg.toFixed(1)} rounds, max ${Math.max(...rounds)}, min ${Math.min(...rounds)}`);
  assert.ok(avg > 1.5, 'bots end the match too fast to be interesting');
});

test('snapshot is JSON-safe and drains events', () => {
  const sim = createSim({ grid, players: fillWithBots(humans(1)), seed: 5 });
  run(sim, 5.2);
  const s1 = snapshot(sim);
  assert.ok(s1.events.some((e) => e.type === 'teleport'));
  assert.deepEqual(JSON.parse(JSON.stringify(s1)), s1);
  assert.equal(snapshot(sim).events.length, 0);
  assert.equal(aliveCount(sim), 5);
});

test('launchSpeed/slideDistance are inverse under the chosen friction', () => {
  const d = slideDistance(0.8);
  const v = launchSpeed(d);
  assert.ok(Math.abs((v * v) / (2 * CONFIG.FRICTION_MPS2) - d) < 1e-9);
});

test('power snaps to levels 1..10 (10 % steps) for humans and at launch', () => {
  assert.equal(quantizePower(0.04), 0.1);
  assert.equal(quantizePower(0.34), 0.3);
  assert.equal(quantizePower(0.36), 0.4);
  assert.equal(quantizePower(7), 1);
  assert.equal(powerToLevel(0.3), 3);
  assert.equal(powerToLevel(1), 10);
  const sim = planned({ spots: [{ x: -3, z: 0 }, { x: 3, z: 0 }] });
  applyInput(sim, 'h1', { power: 0.57 });
  assert.equal(sim.players[0].power, 0.6);
  // bots only ever pick whole levels too
  const bots = createSim({ grid, players: fillWithBots([]).map((p) => ({ ...p, isBot: true })), seed: 3 });
  run(bots, 5.2);
  for (const p of bots.players) assert.equal(Math.round(p.bot.power * 10) / 10, p.bot.power);
});

test("other players' aim and power are hidden while planning, revealed once sliding", () => {
  const sim = createSim({ grid, lobby, players: fillWithBots(humans(1)), seed: 11 });
  run(sim, 5.1);
  assert.equal(sim.phase, PHASE.PLANNING);
  applyInput(sim, 'h1', { yaw: 1.0, power: 0.9 });
  const bot = sim.players[1];
  bot.bot.yaw = 2.2; // a bot's real plan
  bot.yaw = 2.2;
  bot.power = 0.8;
  const mine = snapshot(sim, 'h1', false);
  assert.equal(mine.players[0].yaw, 1);
  assert.equal(mine.players[0].power, 0.9);
  for (const p of mine.players.slice(1)) {
    assert.equal(p.power, 0, 'leaked power');
    assert.ok(Math.abs(p.yaw - sim.players.find((q) => q.id === p.id).faceYaw) < 1e-3, 'leaked aim');
  }
  const spectator = snapshot(sim, 'nobody', false);
  assert.ok(spectator.players.every((p) => p.power === 0));
  // once sliding, everyone is visible
  for (const p of sim.players) p.locked = true;
  advance(sim, 1 / 60);
  assert.equal(sim.phase, PHASE.SLIDING);
  const open = snapshot(sim, 'h1', false);
  assert.equal(open.players[1].yaw, bot.yaw);
});

test('Lobby.glb: Spawn_Lobby is a 15 x 10 m platform with top y=0.7; rotated Shop marker is tolerated', () => {
  assert.ok(Math.abs(lobby.spawn.hx - 7.5) < 1e-6 && Math.abs(lobby.spawn.hz - 5) < 1e-6);
  assert.ok(Math.abs(lobby.spawn.top - 0.7) < 1e-6);
  assert.ok(lobby.nodes.includes('Map Selection') && lobby.nodes.includes('Shop'));
});

test('countdown: ducks spawn 3 m above the lobby platform, drop onto it, then teleport to the grid', () => {
  const sim = createSim({ grid, lobby, players: fillWithBots(humans(1)), seed: 21 });
  const s = lobby.spawn;
  for (const p of sim.players) {
    assert.ok(p.inLobby && p.placed);
    assert.ok(Math.abs(p.y - (s.top + CONFIG.LOBBY_SPAWN_DROP_M)) < 1e-9, 'not spawned above the platform');
    assert.ok(Math.abs(p.x - s.cx) <= s.hx && Math.abs(p.z - s.cz) <= s.hz, 'spawned off the platform');
  }
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) {
    assert.ok(Math.hypot(sim.players[i].x - sim.players[j].x, sim.players[i].z - sim.players[j].z) >= CONFIG.SPAWN_MIN_SEPARATION_M - 1e-9);
  }
  run(sim, 1.5);
  assert.equal(sim.phase, PHASE.COUNTDOWN);
  assert.ok(sim.players.every((p) => p.y === s.top && p.inLobby), 'ducks should have landed on the platform');
  run(sim, 3.7);
  assert.equal(sim.phase, PHASE.PLANNING);
  for (const p of sim.players) {
    assert.equal(p.inLobby, false);
    assert.equal(p.y, grid.top);
    assert.ok(isOnGrid(grid, p.x, p.z));
  }
  const snap = snapshot(sim);
  assert.ok(snap.players.every((p) => p.inLobby === false));
});
