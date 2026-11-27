import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGlbJson, gridFromGltfJson, duckInfoFromGltfJson } from '../shared/glb.js';
import { ASSETS } from '../shared/config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => fs.readFileSync(path.join(root, 'assets', name));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

test('Grid.glb: 9 contiguous 5x5 tiles, top at y=1.15, 15 m footprint', () => {
  const grid = gridFromGltfJson(readGlbJson(read('Grid.glb')));
  assert.equal(grid.tiles.length, 9);
  for (const t of grid.tiles) {
    near(t.hx, 2.5);
    near(t.hz, 2.5);
    near(t.top, 1.15);
  }
  near(grid.top, 1.15);
  near(grid.bounds.minX, -7.5);
  near(grid.bounds.maxX, 7.5);
  near(grid.bounds.minZ, -7.5);
  near(grid.bounds.maxZ, 7.5);
  const centres = new Set(grid.tiles.map((t) => `${t.cx},${t.cz}`));
  assert.equal(centres.size, 9);
});

test('TumblerDuck.glb: feet at y=0, faces +Z, has the three clips the game uses', () => {
  const info = duckInfoFromGltfJson(readGlbJson(read('TumblerDuck.glb')));
  near(info.footY, 0);
  near(info.height, 1.125);
  assert.equal(info.facing, '+Z');
  for (const name of Object.values(ASSETS.DUCK_ANIMS)) assert.ok(info.clipNames.includes(name), `missing clip ${name}`);
  assert.ok(Math.max(Math.abs(info.min[0]), Math.abs(info.max[0])) < 0.4, 'footprint wider than the 0.4 m collision radius assumes');
});

test('reader rejects garbage instead of guessing', () => {
  assert.throws(() => readGlbJson(new Uint8Array(40)), /bad magic/);
  const good = read('Grid.glb');
  assert.throws(() => readGlbJson(good.subarray(0, 100)), /truncated/);
});

test('rotated collision nodes are refused', () => {
  const json = {
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'x', mesh: 0, extras: { collision: true }, rotation: [0, 0.38, 0, 0.92] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ min: [-1, -1, -1], max: [1, 1, 1] }],
  };
  assert.throws(() => gridFromGltfJson(json), /rotated/);
});

test('Lobby.glb: reader tolerates the rotated Shop marker but still refuses it as collision geometry', async () => {
  const { lobbyFromGltfJson } = await import('../shared/glb.js');
  const json = readGlbJson(read('Lobby.glb'));
  const lobby = lobbyFromGltfJson(json, 'Spawn_Lobby');
  near(lobby.spawn.cx, 0);
  near(lobby.spawn.cz, 0);
  near(lobby.spawn.hx, 7.5);
  near(lobby.spawn.hz, 5);
  near(lobby.spawn.top, 0.7);
  assert.throws(() => gridFromGltfJson(json), /Shop.*rotated/);
  assert.throws(() => lobbyFromGltfJson(json, 'Nope'), /no mesh node/);
});
