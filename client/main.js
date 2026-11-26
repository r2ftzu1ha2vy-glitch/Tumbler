// Orchestration: menu -> (offline sim | online room) -> match loop. Input, camera aim and HUD wiring.
import { CONFIG } from '../shared/config.js';
import { clampPower, normalizeYaw } from '../shared/rules.js';
import { advance, applyInput, createSim, fillWithBots, snapshot } from '../shared/sim.js';
import { loadAssets } from './assets.js';
import { createHud } from './hud.js';
import { sampleBuffer } from './interp.js';
import { openConnection } from './net.js';
import { createView } from './view.js';

const canvas = document.getElementById('game');
const hud = createHud();

const IDLE_STATE = Object.freeze({ phase: 'countdown', timer: 0, round: 0, planTime: CONFIG.PLAN_TIME_S, winnerId: null, events: [], players: [] });
const PITCH_MIN = 0.12;
const PITCH_MAX = 1.2;
const INPUT_SEND_MS = 50;

let assets = null;
let view = null;
let session = null; // { kind, tick(dt, now) -> state|null, send(input) }
let conn = null;
let myId = null;
let lobbyInfo = null;
let latestState = null;
let prevPhase = null;
let lastSent = { yaw: NaN, power: NaN };
let lastSentAt = 0;
const keys = new Set();
let heldButton = 0;
// yaw/pitch steer the camera. aimYaw is the direction that will actually be used (frozen while locked in).
const local = { yaw: 0, pitch: 0.5, aimYaw: 0, power: CONFIG.DEFAULT_POWER, locked: false };

const storage = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage can be blocked */ } },
};
const playerName = () => {
  const n = hud.el.nameInput.value.trim().slice(0, 16) || 'Duck';
  storage.set('tumbler.name', n);
  return n;
};

// ------------------------------------------------------------------ sessions
function resetLocalAim() {
  local.yaw = 0;
  local.aimYaw = 0;
  local.pitch = 0.5;
  local.power = CONFIG.DEFAULT_POWER;
  local.locked = false;
  lastSent = { yaw: NaN, power: NaN };
}

function beginMatchUi() {
  view.reset();
  hud.hideMenu();
  hud.hideLobby();
  hud.hideEnd();
  hud.showHud(true);
  prevPhase = null;
  latestState = null;
  resetLocalAim();
}

function startOffline() {
  closeSession();
  myId = 'me';
  const sim = createSim({ grid: assets.grid, players: fillWithBots([{ id: myId, name: playerName(), isBot: false }]) });
  session = {
    kind: 'offline',
    tick: (dt) => {
      advance(sim, dt);
      return snapshot(sim);
    },
    send: (input) => applyInput(sim, myId, input),
  };
  beginMatchUi();
}

function makeOnlineSession() {
  const buf = [];
  const eventQueue = [];
  return {
    kind: 'online',
    buf,
    eventQueue,
    tick: (dt, now) => {
      const s = sampleBuffer(buf, now - CONFIG.INTERP_DELAY_MS);
      if (!s) return null;
      const latest = buf[buf.length - 1];
      const timer = latest.s.phase === 'gameover' ? 0 : Math.max(0, latest.s.timer - (now - latest.at) / 1000);
      return { ...s, timer, events: eventQueue.splice(0) };
    },
    send: (input) => conn?.send({ t: 'in', ...input }),
  };
}

function closeSession() {
  if (conn) {
    const c = conn;
    conn = null;
    c.close();
  }
  session = null;
  latestState = null;
  lobbyInfo = null;
}

async function goOnline(roomCode) {
  closeSession();
  hud.setStatus('Connecting…');
  const pendingConn = openConnection({ onMessage: handleNet, onClose: handleNetClosed });
  conn = pendingConn;
  try {
    await pendingConn.ready;
  } catch (e) {
    conn = null;
    hud.setStatus(`${e.message} Is the server running (npm start)?`, true);
    return;
  }
  pendingConn.send({ t: 'join', room: roomCode || undefined, name: playerName() });
}

function handleNet(m) {
  switch (m.t) {
    case 'joined':
      myId = m.id;
      break;
    case 'lobby':
      lobbyInfo = m;
      if (!session) hud.showLobby({ code: m.room, players: m.players, hostId: m.hostId, myId, maxPlayers: m.maxPlayers });
      break;
    case 'snap': {
      if (!session || session.kind !== 'online') {
        session = makeOnlineSession();
        beginMatchUi();
      }
      session.buf.push({ at: performance.now(), s: m.s });
      if (session.buf.length > 40) session.buf.shift();
      session.eventQueue.push(...m.s.events);
      break;
    }
    case 'error':
      if (session) break;
      if (lobbyInfo) break;
      hud.setStatus(m.msg, true);
      closeSession();
      break;
    default:
      break;
  }
}

function handleNetClosed() {
  if (!conn) return; // we closed it ourselves
  conn = null;
  session = null;
  lobbyInfo = null;
  hud.showMenu('Disconnected from the server.', true);
}

// ------------------------------------------------------------------ input
function canAct(state) {
  const me = state?.players.find((p) => p.id === myId);
  return !!me && me.alive && state.phase === 'planning';
}

function sendAim(extra = {}) {
  session.send({ yaw: local.aimYaw, power: local.power, ...extra });
  lastSent = { yaw: local.aimYaw, power: local.power };
  lastSentAt = performance.now();
}

function toggleLock() {
  if (!session || !canAct(latestState)) return;
  local.locked = !local.locked;
  if (!local.locked) local.aimYaw = local.yaw;
  sendAim({ lock: local.locked });
}

function nudgePower(delta) {
  if (!canAct(latestState) || local.locked) return;
  local.power = clampPower(local.power + delta);
}

function pumpInput(dt, state) {
  if (!canAct(state)) return;
  if (!local.locked) {
    const up = keys.has('ArrowUp') || keys.has('KeyW');
    const down = keys.has('ArrowDown') || keys.has('KeyS');
    const dir = (up ? 1 : 0) - (down ? 1 : 0) + heldButton;
    if (dir !== 0) local.power = clampPower(local.power + dir * CONFIG.POWER_RATE_PER_S * dt);
    local.aimYaw = local.yaw;
    const changed = local.aimYaw !== lastSent.yaw || local.power !== lastSent.power;
    if (changed && performance.now() - lastSentAt >= INPUT_SEND_MS) sendAim();
  }
}

function releaseInput() {
  keys.clear();
  heldButton = 0;
}

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.code === 'ArrowUp' || e.code === 'ArrowDown' || e.code === 'Space') e.preventDefault();
  if (e.code === 'Space' || e.code === 'Enter') {
    if (!e.repeat) toggleLock();
    return;
  }
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', releaseInput);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseInput();
});
document.addEventListener('pointerlockchange', () => {
  if (document.pointerLockElement !== canvas) releaseInput();
});

window.addEventListener('mousemove', (e) => {
  if (!session) return;
  const captured = document.pointerLockElement === canvas;
  if (!captured && !(e.buttons & 1)) return; // fallback when pointer lock is unavailable: drag to look
  local.yaw = normalizeYaw(local.yaw - e.movementX * CONFIG.MOUSE_SENS_RAD_PER_PX);
  local.pitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, local.pitch + e.movementY * CONFIG.MOUSE_SENS_RAD_PER_PX));
});
canvas.addEventListener('click', () => {
  if (!session || document.pointerLockElement === canvas) return;
  try {
    const r = canvas.requestPointerLock();
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch { /* unsupported: drag-to-look still works */ }
});
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  nudgePower((e.deltaY < 0 ? 1 : -1) * CONFIG.POWER_WHEEL_STEP);
}, { passive: false });

const bindHold = (node, dir) => {
  node.addEventListener('pointerdown', (e) => {
    e.preventDefault(); // also stops the button taking focus, so Space keeps meaning "launch"
    heldButton = dir;
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) node.addEventListener(ev, () => { if (heldButton === dir) heldButton = 0; });
};
bindHold(hud.el.pwUp, 1);
bindHold(hud.el.pwDown, -1);
hud.el.launch.addEventListener('click', (e) => {
  toggleLock();
  e.currentTarget.blur(); // otherwise Space would also "click" the focused button and toggle twice
});

// ------------------------------------------------------------------ menu wiring
hud.el.btnOffline.addEventListener('click', startOffline);
hud.el.btnCreate.addEventListener('click', () => goOnline(''));
hud.el.btnJoin.addEventListener('click', () => {
  const code = hud.el.codeInput.value.trim().toUpperCase();
  if (code.length !== 4) return hud.setStatus('Enter the 4-letter room code.', true);
  goOnline(code);
});
hud.el.codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') hud.el.btnJoin.click();
});
hud.el.lobbyStart.addEventListener('click', () => conn?.send({ t: 'start' }));
const backToMenu = () => { window.location.href = window.location.pathname; };
hud.el.lobbyLeave.addEventListener('click', backToMenu);
hud.el.endMenu.addEventListener('click', backToMenu);
hud.el.endAgain.addEventListener('click', () => {
  if (session?.kind === 'offline') startOffline();
  else conn?.send({ t: 'start' });
});

// ------------------------------------------------------------------ frame loop
function onPhaseChange(state, me) {
  if (prevPhase === 'gameover' && state.phase !== 'gameover') {
    view.reset();
    resetLocalAim();
    hud.hideEnd();
  }
  if (state.phase === 'planning') {
    if (state.round === 1 && me) {
      local.yaw = me.yaw; // teleport leaves you facing the middle of the grid
      local.aimYaw = me.yaw;
    }
    local.locked = false;
    if (me && me.alive) sendAim();
  }
  if (state.phase === 'gameover') {
    const winner = state.players.find((p) => p.id === state.winnerId);
    const won = winner && winner.id === myId;
    const isOffline = session.kind === 'offline';
    hud.showEnd({
      title: won ? 'You win! 🦆👑' : winner ? `${winner.name} wins!` : "It's a draw!",
      sub: won ? 'Last duck standing.' : me && !me.alive ? 'You got knocked off the grid.' : 'Better luck next round.',
      canAgain: isOffline || lobbyInfo?.hostId === myId,
      againLabel: 'Waiting for host…',
    });
  }
  prevPhase = state.phase;
}

let lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;

  const idleCtx = { myId: null, yaw: 0, pitch: 0.5, aimYaw: 0, power: CONFIG.DEFAULT_POWER };
  const state = session ? session.tick(dt, now) : null;
  if (!state) {
    view.render(IDLE_STATE, idleCtx, dt);
    return;
  }
  latestState = state;
  const me = state.players.find((p) => p.id === myId) ?? null;
  if (state.phase !== prevPhase) onPhaseChange(state, me);
  view.handleEvents(state.events);
  pumpInput(dt, state);
  if (hud.isEndShown()) hud.setEndAction(session.kind === 'offline' || lobbyInfo?.hostId === myId, 'Waiting for host…');

  view.render(state, { myId, yaw: local.yaw, pitch: local.pitch, aimYaw: local.aimYaw, power: local.power }, dt);
  hud.update(state, { me, myId, power: local.power, locked: local.locked });
}

// ------------------------------------------------------------------ boot
async function boot() {
  hud.el.nameInput.value = storage.get('tumbler.name') || `Duck${Math.floor(Math.random() * 90 + 10)}`;
  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam) hud.el.codeInput.value = roomParam.slice(0, 4).toUpperCase();
  try {
    assets = await loadAssets();
    view = createView(canvas, assets);
  } catch (e) {
    console.error(e);
    hud.fatal(String(e?.message ?? e));
    return;
  }
  window.addEventListener('resize', () => view.resize());
  hud.setMenuEnabled(true);
  hud.setStatus(roomParam ? 'Room code filled in. Press Join.' : '');
  // Static hosts (GitHub Pages) have no game server: keep offline play, switch online off.
  let hasServer = false;
  try {
    hasServer = (await fetch('./healthz', { cache: 'no-store' })).ok;
  } catch { /* no server */ }
  if (!hasServer) {
    hud.el.btnCreate.disabled = true;
    hud.el.btnJoin.disabled = true;
    hud.setStatus('Online rooms need the Node server (npm start). Playing vs bots works right here.');
  }
  requestAnimationFrame(frame);
}
boot();
