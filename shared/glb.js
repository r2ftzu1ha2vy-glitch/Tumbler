// Reads the facts the game needs straight out of the .glb files, so no tile position or size is
// ever typed into the code. Pure functions: no DOM, no three.js, runs in Node and in the browser.
//
// Supported node transforms: translation + scale (a column-major `matrix` or TRS with identity
// rotation). Anything rotated/sheared throws instead of silently producing a wrong collision box.

const GLB_MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a; // 'JSON'
const EPS = 1e-6;

function toDataView(source) {
  if (source instanceof ArrayBuffer) return new DataView(source);
  if (ArrayBuffer.isView(source)) return new DataView(source.buffer, source.byteOffset, source.byteLength);
  throw new Error('readGlbJson: expected ArrayBuffer or typed array');
}

export function readGlbJson(source) {
  const view = toDataView(source);
  if (view.byteLength < 20) throw new Error('GLB too small');
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('not a GLB (bad magic)');
  const version = view.getUint32(4, true);
  if (version !== 2) throw new Error(`unsupported GLB version ${version}`);
  const total = view.getUint32(8, true);
  if (total > view.byteLength) throw new Error(`GLB truncated: header says ${total} bytes, got ${view.byteLength}`);
  let off = 12;
  while (off + 8 <= total) {
    const len = view.getUint32(off, true);
    const type = view.getUint32(off + 4, true);
    const start = off + 8;
    const end = start + len;
    if (end > total) throw new Error('GLB chunk overruns the file');
    if (type === CHUNK_JSON) {
      const bytes = new Uint8Array(view.buffer, view.byteOffset + start, len);
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    off = end;
  }
  throw new Error('GLB has no JSON chunk');
}

// Rotated/sheared nodes are allowed to exist (the lobby has a rotated marker); they are only
// refused when something asks for their collision box (see requireAxisAligned).
function localScaleTranslate(node) {
  if (node.matrix) {
    const m = node.matrix;
    if (m.length !== 16) throw new Error(`node "${node.name ?? '(unnamed)'}": bad matrix length`);
    const rotated = [1, 2, 4, 6, 8, 9].some((i) => Math.abs(m[i]) > EPS);
    return { s: [m[0], m[5], m[10]], t: [m[12], m[13], m[14]], rotated };
  }
  const r = node.rotation ?? [0, 0, 0, 1];
  const rotated = Math.abs(r[0]) > EPS || Math.abs(r[1]) > EPS || Math.abs(r[2]) > EPS;
  return { s: node.scale ?? [1, 1, 1], t: node.translation ?? [0, 0, 0], rotated };
}

function requireAxisAligned(node, rotated) {
  if (rotated) throw new Error(`node "${node.name ?? '(unnamed)'}" is rotated; only scale+translate is supported`);
}

function meshBounds(json, meshIndex, what) {
  const mesh = json.meshes?.[meshIndex];
  if (!mesh) throw new Error(`${what}: mesh ${meshIndex} missing`);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const prim of mesh.primitives ?? []) {
    const idx = prim.attributes?.POSITION;
    if (idx === undefined) continue;
    const acc = json.accessors?.[idx];
    if (!acc || !Array.isArray(acc.min) || !Array.isArray(acc.max) || acc.min.length < 3 || acc.max.length < 3) {
      throw new Error(`${what}: POSITION accessor has no min/max, cannot bound it`);
    }
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], acc.min[k]);
      hi[k] = Math.max(hi[k], acc.max[k]);
    }
  }
  if (!Number.isFinite(lo[0])) throw new Error(`${what}: mesh has no POSITION data`);
  return { min: lo, max: hi };
}

function worldAabb(b, ws, wt) {
  const min = [0, 0, 0];
  const max = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const a = ws[k] * b.min[k] + wt[k];
    const c = ws[k] * b.max[k] + wt[k];
    min[k] = Math.min(a, c);
    max[k] = Math.max(a, c);
  }
  return { min, max };
}

function walkScene(json, visit) {
  const roots = json.scenes?.[json.scene ?? 0]?.nodes;
  if (!roots) throw new Error('GLB has no scene');
  const rec = (idx, ps, pt, depth, parentRotated) => {
    if (depth > 64) throw new Error('node hierarchy too deep');
    const node = json.nodes?.[idx];
    if (!node) throw new Error(`node ${idx} missing`);
    const { s, t, rotated: localRotated } = localScaleTranslate(node);
    const rotated = parentRotated || localRotated;
    const ws = [ps[0] * s[0], ps[1] * s[1], ps[2] * s[2]];
    const wt = [pt[0] + ps[0] * t[0], pt[1] + ps[1] * t[1], pt[2] + ps[2] * t[2]];
    visit(node, ws, wt, rotated);
    for (const c of node.children ?? []) rec(c, ws, wt, depth + 1, rotated);
  };
  for (const r of roots) rec(r, [1, 1, 1], [0, 0, 0], 0, false);
}

// Collision tiles = every mesh node whose glTF `extras.collision` is true.
export function gridFromGltfJson(json) {
  const tiles = [];
  walkScene(json, (node, ws, wt, rotated) => {
    if (node.extras?.collision !== true || node.mesh === undefined) return;
    requireAxisAligned(node, rotated);
    const name = node.name ?? '(unnamed)';
    const box = worldAabb(meshBounds(json, node.mesh, `node "${name}"`), ws, wt);
    tiles.push({
      name,
      cx: (box.min[0] + box.max[0]) / 2,
      cz: (box.min[2] + box.max[2]) / 2,
      hx: (box.max[0] - box.min[0]) / 2,
      hz: (box.max[2] - box.min[2]) / 2,
      minY: box.min[1],
      top: box.max[1],
    });
  });
  if (tiles.length === 0) throw new Error('no collision tiles found (nodes with extras.collision === true)');
  const top = Math.max(...tiles.map((t) => t.top));
  for (const t of tiles) {
    if (Math.abs(t.top - top) > 1e-3) throw new Error(`tile "${t.name}" has a different top height; uneven grids are not supported`);
  }
  const bounds = {
    minX: Math.min(...tiles.map((t) => t.cx - t.hx)),
    maxX: Math.max(...tiles.map((t) => t.cx + t.hx)),
    minZ: Math.min(...tiles.map((t) => t.cz - t.hz)),
    maxZ: Math.max(...tiles.map((t) => t.cz + t.hz)),
  };
  return { tiles, top, bounds };
}

// Footprint, height, facing and clip names of the duck model.
export function duckInfoFromGltfJson(json) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let billZ = null;
  let bodyZ = null;
  walkScene(json, (node, ws, wt, rotated) => {
    if (node.mesh === undefined) return;
    requireAxisAligned(node, rotated);
    const box = worldAabb(meshBounds(json, node.mesh, `node "${node.name}"`), ws, wt);
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k], box.min[k]);
      hi[k] = Math.max(hi[k], box.max[k]);
    }
    const centerZ = (box.min[2] + box.max[2]) / 2;
    if (node.name === 'bill') billZ = centerZ;
    if (node.name === 'body') bodyZ = centerZ;
  });
  if (!Number.isFinite(lo[0])) throw new Error('duck has no meshes');
  let facing = 'unknown';
  if (billZ !== null && bodyZ !== null) facing = billZ > bodyZ ? '+Z' : '-Z';
  return {
    min: lo,
    max: hi,
    footY: lo[1],
    height: hi[1] - lo[1],
    facing,
    clipNames: (json.animations ?? []).map((a) => a.name),
  };
}

// The lobby: the platform ducks drop onto while the pre-match countdown runs. It is the node named
// `spawnNodeName` ("Spawn_Lobby" in Lobby.glb). Other lobby nodes (map pads, shop marker) are drawn
// but have no gameplay yet, so they are only listed by name.
export function lobbyFromGltfJson(json, spawnNodeName) {
  let spawn = null;
  const nodes = [];
  walkScene(json, (node, ws, wt, rotated) => {
    nodes.push(node.name ?? '(unnamed)');
    if (node.name !== spawnNodeName || node.mesh === undefined) return;
    requireAxisAligned(node, rotated);
    const box = worldAabb(meshBounds(json, node.mesh, `node "${node.name}"`), ws, wt);
    spawn = {
      cx: (box.min[0] + box.max[0]) / 2,
      cz: (box.min[2] + box.max[2]) / 2,
      hx: (box.max[0] - box.min[0]) / 2,
      hz: (box.max[2] - box.min[2]) / 2,
      top: box.max[1],
    };
  });
  if (!spawn) throw new Error(`lobby has no mesh node named "${spawnNodeName}"`);
  return { spawn, nodes };
}
