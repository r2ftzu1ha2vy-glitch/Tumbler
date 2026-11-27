// Pure game rules shared by the sim, the bots and the UI.
import { CONFIG } from './config.js';

export function clampPower(power, cfg = CONFIG) {
  return Math.min(1, Math.max(cfg.MIN_POWER, power));
}

// Power is a level 1..POWER_LEVELS (level / POWER_LEVELS of full power). Everything that accepts a
// power snaps it to a level, so humans and bots are on the same ladder.
export function quantizePower(power, cfg = CONFIG) {
  return clampPower(Math.round(power * cfg.POWER_LEVELS) / cfg.POWER_LEVELS, cfg);
}

export function powerToLevel(power, cfg = CONFIG) {
  return Math.round(quantizePower(power, cfg) * cfg.POWER_LEVELS);
}

// Wraps to (-PI, PI].
export function normalizeYaw(yaw) {
  const full = Math.PI * 2;
  let v = yaw % full;
  if (v > Math.PI) v -= full;
  else if (v <= -Math.PI) v += full;
  return v;
}

export function lerpAngle(a, b, k) {
  return normalizeYaw(a + normalizeYaw(b - a) * k);
}

// How far (metres) a duck travels on an unobstructed slide at this power.
export function slideDistance(power, cfg = CONFIG) {
  return clampPower(power, cfg) * cfg.MAX_SLIDE_M;
}

// Launch speed (m/s) that yields `dist` metres under constant deceleration: v = sqrt(2 a d).
export function launchSpeed(dist, cfg = CONFIG) {
  return Math.sqrt(2 * cfg.FRICTION_MPS2 * Math.max(0, dist));
}

export function aimDir(yaw) {
  return { x: Math.sin(yaw), z: Math.cos(yaw) };
}
