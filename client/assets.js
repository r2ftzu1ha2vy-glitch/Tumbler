// Loads both .glb files. Collision data comes from the raw glTF JSON (shared/glb.js, same code the
// server runs); the three.js scene graphs are only for drawing.
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { ASSETS } from '../shared/config.js';
import { duckInfoFromGltfJson, gridFromGltfJson, readGlbJson } from '../shared/glb.js';

async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url} (HTTP ${res.status})`);
  return res.arrayBuffer();
}

function parseGltf(loader, buffer) {
  return new Promise((resolve, reject) => loader.parse(buffer.slice(0), '', resolve, reject));
}

export async function loadAssets() {
  const [gridBuf, duckBuf] = await Promise.all([fetchBuffer(ASSETS.GRID_GLB), fetchBuffer(ASSETS.DUCK_GLB)]);
  const grid = gridFromGltfJson(readGlbJson(gridBuf));
  const duckInfo = duckInfoFromGltfJson(readGlbJson(duckBuf));
  for (const name of Object.values(ASSETS.DUCK_ANIMS)) {
    if (!duckInfo.clipNames.includes(name)) throw new Error(`TumblerDuck.glb has no animation named "${name}"`);
  }
  if (duckInfo.facing !== '+Z') throw new Error(`Expected the duck to face +Z, found ${duckInfo.facing}; yaw math would be mirrored`);
  const loader = new GLTFLoader();
  const [gridGltf, duckGltf] = await Promise.all([parseGltf(loader, gridBuf), parseGltf(loader, duckBuf)]);
  return { grid, duckInfo, gridScene: gridGltf.scene, duckScene: duckGltf.scene, duckClips: duckGltf.animations };
}
