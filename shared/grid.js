// Grid queries. A grid is { tiles: [{cx, cz, hx, hz, top}], top, bounds } as produced by glb.js.
// Ground is flat: every tile has the same top (glb.js enforces it).

export function isOnGrid(grid, x, z) {
  for (const t of grid.tiles) {
    if (Math.abs(x - t.cx) <= t.hx && Math.abs(z - t.cz) <= t.hz) return true;
  }
  return false;
}

// Distance along the unit direction (dx, dz) from (x, z) to the first off-grid sample.
// Returns 0 if the start is already off-grid and maxDist if the ray stays on the grid that long.
export function rayExitDistance(grid, x, z, dx, dz, maxDist, step = 0.1) {
  if (!isOnGrid(grid, x, z)) return 0;
  for (let d = step; d <= maxDist; d += step) {
    if (!isOnGrid(grid, x + dx * d, z + dz * d)) return d;
  }
  return maxDist;
}

// Shortest distance to the grid edge, sampled over `dirs` evenly spaced directions.
export function edgeDistance(grid, x, z, dirs = 16, maxDist = 20) {
  let best = maxDist;
  for (let i = 0; i < dirs; i++) {
    const a = (i / dirs) * Math.PI * 2;
    best = Math.min(best, rayExitDistance(grid, x, z, Math.sin(a), Math.cos(a), maxDist));
  }
  return best;
}
