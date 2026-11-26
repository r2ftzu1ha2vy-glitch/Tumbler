// three.js presentation layer. Draws a snapshot-shaped state; owns no game logic.
// Coordinates: Y up, right-handed, metres. Duck model faces +Z at yaw 0, so duck.rotation.y = yaw.
import * as THREE from 'three';
import { ASSETS, PLAYER_COLORS } from '../shared/config.js';
import { slideDistance } from '../shared/rules.js';

const WATER_DEPTH_M = 7.15; // decorative water plane below the grid (not collision, not gameplay)
const CAM_DISTANCE_M = 6.5;
const CAM_LOOK_AHEAD_M = 3;
const SPAWN_POP_S = 0.35;

const easeOutBack = (t) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

function roundedRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export function createView(canvas, assets) {
  const top = assets.grid.top;
  const waterY = top - WATER_DEPTH_M;
  const clipNames = ASSETS.DUCK_ANIMS;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x8fd3ff);
  scene.fog = new THREE.Fog(0x8fd3ff, 45, 140);
  const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 300);

  scene.add(new THREE.HemisphereLight(0xffffff, 0x6a8bb0, 1.1));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(10, 22, 8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 14, bottom: -14, near: 1, far: 60 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  assets.gridScene.traverse((o) => {
    if (o.isMesh) o.receiveShadow = true;
  });
  scene.add(assets.gridScene);

  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 600),
    new THREE.MeshStandardMaterial({ color: 0x2f9fd8, roughness: 0.35, transparent: true, opacity: 0.92 }),
  );
  water.rotation.x = -Math.PI / 2;
  water.position.y = waterY;
  scene.add(water);

  // ---- aim indicator: arrow on the ground whose length is the predicted slide distance
  const aimMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false });
  const shaftGeo = new THREE.BoxGeometry(1, 0.03, 1);
  shaftGeo.translate(0, 0, 0.5);
  const tipGeo = new THREE.ConeGeometry(0.55, 0.9, 3);
  tipGeo.rotateX(Math.PI / 2);
  const aim = new THREE.Group();
  const shaft = new THREE.Mesh(shaftGeo, aimMat);
  const tip = new THREE.Mesh(tipGeo, aimMat);
  tip.scale.y = 0.2;
  aim.add(shaft, tip);
  aim.visible = false;
  scene.add(aim);

  // ---- per-player visuals
  const visuals = new Map();
  const fx = [];

  function makeVisual(p) {
    const color = PLAYER_COLORS[p.ci % PLAYER_COLORS.length];
    const root = new THREE.Group();
    const model = assets.duckScene.clone(true);
    model.traverse((o) => {
      if (o.isMesh) o.castShadow = true;
    });
    root.add(model);

    const mixer = new THREE.AnimationMixer(model);
    const actions = {};
    for (const [key, name] of Object.entries(clipNames)) {
      const clip = assets.duckClips.find((c) => c.name === name);
      actions[key] = mixer.clipAction(clip);
    }
    actions.SIT.setLoop(THREE.LoopOnce, 1);
    actions.SIT.clampWhenFinished = true;
    actions.SIT.timeScale = ASSETS.SIT_TIMESCALE;
    actions.STAND.setLoop(THREE.LoopOnce, 1);
    actions.STAND.clampWhenFinished = true;

    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 320;
    labelCanvas.height = 80;
    const labelTex = new THREE.CanvasTexture(labelCanvas);
    labelTex.colorSpace = THREE.SRGBColorSpace;
    const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: labelTex, transparent: true, depthTest: false }));
    label.scale.set(2.1, 0.525, 1);
    label.position.y = 1.75;
    label.renderOrder = 10;
    root.add(label);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.68, 40),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }),
    );
    ring.rotation.x = -Math.PI / 2;

    root.visible = false;
    ring.visible = false;
    scene.add(root, ring);

    const v = {
      root, model, mixer, actions, ring, labelCanvas, labelTex,
      labelKey: '', anim: null, wasPlaced: false, spawnT: 0, splashed: false,
    };
    mixer.addEventListener('finished', (e) => {
      if (e.action === actions.STAND && v.anim === 'STAND') setAnim(v, 'IDLE');
    });
    setAnim(v, 'IDLE');
    mixer.update(Math.random() * 3); // desync idle loops between ducks
    return v;
  }

  function setAnim(v, key) {
    if (v.anim === key) return;
    const next = v.actions[key];
    const prev = v.anim ? v.actions[v.anim] : null;
    next.reset();
    next.enabled = true;
    next.setEffectiveWeight(1);
    next.play();
    if (prev) prev.crossFadeTo(next, 0.15, false);
    v.anim = key;
  }

  function drawLabel(v, p, isMe) {
    const key = `${p.name}|${p.locked}|${isMe}`;
    if (v.labelKey === key) return;
    v.labelKey = key;
    const c = v.labelCanvas;
    const g = c.getContext('2d');
    g.clearRect(0, 0, c.width, c.height);
    g.fillStyle = 'rgba(15,27,45,0.8)';
    roundedRect(g, 0, 8, c.width, 64, 28);
    g.fill();
    g.fillStyle = PLAYER_COLORS[p.ci % PLAYER_COLORS.length];
    g.beginPath();
    g.arc(36, 40, 13, 0, Math.PI * 2);
    g.fill();
    g.font = 'bold 30px system-ui, sans-serif';
    g.fillStyle = '#ffffff';
    g.textBaseline = 'middle';
    g.fillText(`${isMe ? '▶ ' : ''}${p.name}${p.locked ? ' ✔' : ''}`, 62, 42, 240);
    v.labelTex.needsUpdate = true;
  }

  function disposeVisual(v) {
    scene.remove(v.root, v.ring);
    v.labelTex.dispose();
    v.root.traverse((o) => {
      if (o.isSprite) o.material.dispose();
    });
    v.ring.geometry.dispose();
    v.ring.material.dispose();
    v.mixer.stopAllAction();
  }

  function ringFx(x, y, z, color, maxScale, dur, beam = false) {
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.5, 40), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, y, z);
    scene.add(mesh);
    fx.push({ mesh, t: 0, dur, maxScale, grow: true });
    if (beam) {
      const bmat = mat.clone();
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 7, 20, 1, true), bmat);
      b.position.set(x, y + 3.5, z);
      scene.add(b);
      fx.push({ mesh: b, t: 0, dur: dur * 1.2, maxScale: 1, grow: false });
    }
  }

  function updateFx(dt) {
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i];
      f.t += dt;
      const k = Math.min(1, f.t / f.dur);
      if (f.grow) f.mesh.scale.setScalar(1 + (f.maxScale - 1) * k);
      f.mesh.material.opacity = 0.8 * (1 - k);
      if (k >= 1) {
        scene.remove(f.mesh);
        f.mesh.geometry.dispose();
        f.mesh.material.dispose();
        fx.splice(i, 1);
      }
    }
  }

  // ---- camera
  const camTarget = new THREE.Vector3();
  let camFocusId = null;
  let orbitT = 0;

  function pickFocus(state, myId) {
    const me = state.players.find((p) => p.id === myId);
    if (me && me.placed && me.alive) return me;
    let best = null;
    for (const p of state.players) {
      if (!p.placed || !p.alive) continue;
      if (best === null || Math.hypot(p.x, p.z) < Math.hypot(best.x, best.z)) best = p;
    }
    if (best) return best;
    if (state.winnerId) return state.players.find((p) => p.id === state.winnerId && p.placed && !p.gone) ?? null;
    return null;
  }

  function updateCamera(dt, state, ctx) {
    const focus = pickFocus(state, ctx.myId);
    if (!focus) {
      camFocusId = null;
      orbitT += dt;
      camera.position.set(Math.sin(orbitT * 0.15) * 17, top + 9, Math.cos(orbitT * 0.15) * 17);
      camera.lookAt(0, top, 0);
      return;
    }
    const tx = focus.x;
    const ty = focus.y + 0.6;
    const tz = focus.z;
    if (camFocusId === null) camTarget.set(tx, ty, tz);
    else camTarget.lerp(new THREE.Vector3(tx, ty, tz), 1 - Math.exp(-8 * dt));
    camFocusId = focus.id;
    const { yaw, pitch } = ctx;
    const cp = Math.cos(pitch);
    camera.position.set(
      camTarget.x - Math.sin(yaw) * cp * CAM_DISTANCE_M,
      camTarget.y + Math.sin(pitch) * CAM_DISTANCE_M,
      camTarget.z - Math.cos(yaw) * cp * CAM_DISTANCE_M,
    );
    camera.lookAt(camTarget.x + Math.sin(yaw) * CAM_LOOK_AHEAD_M, camTarget.y + 0.2, camTarget.z + Math.cos(yaw) * CAM_LOOK_AHEAD_M);
  }

  // ---- public API
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }

  function reset() {
    for (const v of visuals.values()) disposeVisual(v);
    visuals.clear();
    camFocusId = null;
  }

  function handleEvents(events) {
    for (const e of events) {
      if (e.type === 'bump') ringFx(e.x, top + 0.1, e.z, 0xfff2b0, 1 + Math.min(2.5, e.speed * 0.25), 0.35);
    }
  }

  // state: snapshot-shaped. ctx: { myId, yaw, pitch, aimYaw, power }: the local player's live values.
  // yaw/pitch steer the camera; aimYaw is the committed aim (frozen while locked in).
  function render(state, ctx, dt) {
    const me = state.players.find((p) => p.id === ctx.myId);

    for (const p of state.players) {
      let v = visuals.get(p.id);
      if (!v) {
        v = makeVisual(p);
        visuals.set(p.id, v);
      }
      const isMe = p.id === ctx.myId;
      const shown = p.placed && !p.gone && p.y > waterY - 0.5;
      v.root.visible = shown;
      v.ring.visible = shown && p.alive;
      if (!shown) {
        v.wasPlaced = p.placed && !p.gone;
        continue;
      }
      if (!v.wasPlaced) {
        v.wasPlaced = true;
        v.spawnT = 0;
        ringFx(p.x, top + 0.05, p.z, PLAYER_COLORS[p.ci % PLAYER_COLORS.length], 3, 0.7, true);
      }
      v.spawnT += dt;
      v.root.scale.setScalar(easeOutBack(Math.min(1, v.spawnT / SPAWN_POP_S)));
      v.root.position.set(p.x, p.y, p.z);
      v.root.rotation.y = isMe && state.phase === 'planning' && p.alive ? ctx.aimYaw : p.yaw;

      if (p.alive) {
        v.model.rotation.set(0, 0, 0);
        const sliding = state.phase === 'sliding';
        if (sliding) setAnim(v, 'SIT');
        else if (v.anim === 'SIT') setAnim(v, 'STAND');
        else if (v.anim !== 'STAND') setAnim(v, 'IDLE');
      } else {
        v.model.rotation.x += dt * 5.5;
        v.model.rotation.z += dt * 2.2;
        if (!v.splashed && p.y < waterY + 1) {
          v.splashed = true;
          ringFx(p.x, waterY + 0.05, p.z, 0xffffff, 4, 0.9);
        }
      }
      v.ring.position.set(p.x, top + 0.03, p.z);
      drawLabel(v, p, isMe);
      v.mixer.update(dt);
    }

    // aim arrow: only for my living duck while I can still change the plan
    const aiming = me && me.placed && me.alive && state.phase === 'planning';
    aim.visible = !!aiming;
    if (aiming) {
      const d = slideDistance(ctx.power);
      shaft.scale.set(0.32, 1, d);
      tip.position.z = d + 0.45;
      aimMat.color.setHSL((1 - ctx.power) * 0.33, 0.9, 0.55);
      aim.position.set(me.x, top + 0.04, me.z);
      aim.rotation.y = ctx.aimYaw;
    }

    updateCamera(dt, state, ctx);
    updateFx(dt);
    renderer.render(scene, camera);
  }

  resize();
  return { resize, reset, handleEvents, render };
}
