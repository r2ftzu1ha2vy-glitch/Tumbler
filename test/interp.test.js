import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blendSnapshots, sampleBuffer } from '../client/interp.js';

const P = (o) => ({ id: 'a', placed: true, alive: true, x: 0, y: 1, z: 0, yaw: 0, ...o });
const S = (p, extra = {}) => ({ phase: 'sliding', events: [{ type: 'x' }], players: [p], ...extra });

test('lerps position and wraps yaw the short way', () => {
  const out = blendSnapshots(S(P({ x: 0, yaw: 3.0 })), S(P({ x: 2, yaw: -3.0 })), 0.5);
  assert.equal(out.players[0].x, 1);
  assert.ok(Math.abs(Math.abs(out.players[0].yaw) - Math.PI) < 0.2);
  assert.deepEqual(out.events, []);
});

test('big jumps (teleports) are not smeared across the arena', () => {
  const out = blendSnapshots(S(P({ x: 0 })), S(P({ x: 9 })), 0.5);
  assert.equal(out.players[0].x, 9);
});

test('sampleBuffer picks the bracketing pair and never replays events', () => {
  const buf = [{ at: 0, s: S(P({ x: 0 })) }, { at: 100, s: S(P({ x: 2 })) }];
  assert.equal(sampleBuffer(buf, 50).players[0].x, 1);
  assert.equal(sampleBuffer(buf, 500).players[0].x, 2);
  assert.equal(sampleBuffer(buf, -5).players[0].x, 0);
  assert.deepEqual(sampleBuffer(buf, 500).events, []);
  assert.equal(sampleBuffer([], 5), null);
});
