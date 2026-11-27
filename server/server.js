// Static file server + authoritative WebSocket rooms for Tumbler.
//   npm start            -> http://localhost:8080   (PORT env var overrides)
// One room = one match. Humans fill seats (max 5); the rest of the seats are bots when the host starts.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { ASSETS, CONFIG } from '../shared/config.js';
import { readGlbJson, gridFromGltfJson, lobbyFromGltfJson } from '../shared/glb.js';
import { PHASE, advance, applyInput, convertToBot, createSim, fillWithBots, snapshot } from '../shared/sim.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8080);
const MAX_SPECTATORS = 15;
const MSG_PER_SECOND = 80; // per client; input floods are dropped

// The grid is read from the same Grid.glb the client renders, so server and client cannot disagree.
const grid = gridFromGltfJson(readGlbJson(fs.readFileSync(path.join(ROOT, 'assets', 'Grid.glb'))));
const lobby = lobbyFromGltfJson(readGlbJson(fs.readFileSync(path.join(ROOT, 'assets', 'Lobby.glb'))), ASSETS.LOBBY_SPAWN_NODE);

const MOUNTS = [
  ['/client/', path.join(ROOT, 'client')],
  ['/shared/', path.join(ROOT, 'shared')],
  ['/assets/', path.join(ROOT, 'assets')],
  ['/vendor/', path.join(ROOT, 'vendor')],
];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function resolveRequest(urlPath) {
  let p;
  try {
    p = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return null;
  }
  if (p === '/') return path.join(ROOT, 'index.html');
  for (const [prefix, base] of MOUNTS) {
    if (!p.startsWith(prefix)) continue;
    const full = path.resolve(base, '.' + p.slice(prefix.length - 1));
    if (full === base || full.startsWith(base + path.sep)) return full;
  }
  return null;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  if ((req.url ?? '').split('?')[0] === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); // lets the page tell "Node server" from "static host"
    return;
  }
  const file = resolveRequest(req.url ?? '/');
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': st.size,
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  });
});

// ---------------------------------------------------------------- rooms
const rooms = new Map();
let nextClientId = 1;

function makeRoomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[Math.floor(Math.random() * letters.length)];
    if (!rooms.has(c)) return c;
  }
}

function cleanName(v) {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16) : '';
  return s || 'Duck';
}

const send = (ws, msg) => {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
};

function matchActive(room) {
  return room.sim !== null && room.sim.phase !== PHASE.GAMEOVER;
}

function broadcastLobby(room) {
  const msg = {
    t: 'lobby',
    room: room.code,
    hostId: room.hostId,
    state: matchActive(room) ? 'playing' : 'lobby',
    players: [...room.clients.values()].map((c) => ({ id: c.id, name: c.name, spectator: c.spectator })),
    maxPlayers: CONFIG.MAX_PLAYERS,
  };
  for (const c of room.clients.values()) send(c.ws, msg);
}

function playerCount(room) {
  let n = 0;
  for (const c of room.clients.values()) if (!c.spectator) n++;
  return n;
}

function handleJoin(client, msg) {
  if (client.room) return;
  client.name = cleanName(msg.name);
  let room;
  if (typeof msg.room === 'string' && msg.room.trim() !== '') {
    room = rooms.get(msg.room.trim().toUpperCase());
    if (!room) return send(client.ws, { t: 'error', msg: 'No room with that code.' });
  } else {
    room = { code: makeRoomCode(), hostId: null, clients: new Map(), sim: null, lastTick: 0, lastSnap: 0 };
    rooms.set(room.code, room);
  }
  if (matchActive(room)) {
    if (room.clients.size >= CONFIG.MAX_PLAYERS + MAX_SPECTATORS) return send(client.ws, { t: 'error', msg: 'Room is full.' });
    client.spectator = true;
  } else {
    if (playerCount(room) >= CONFIG.MAX_PLAYERS) return send(client.ws, { t: 'error', msg: `Room is full (${CONFIG.MAX_PLAYERS} players).` });
    client.spectator = false;
  }
  client.room = room;
  room.clients.set(client.id, client);
  if (room.hostId === null) room.hostId = client.id;
  send(client.ws, { t: 'joined', id: client.id, room: room.code });
  broadcastLobby(room);
}

function handleStart(client) {
  const room = client.room;
  if (!room || room.hostId !== client.id || matchActive(room)) return;
  const seated = [];
  for (const c of room.clients.values()) {
    c.spectator = seated.length >= CONFIG.MAX_PLAYERS;
    if (!c.spectator) seated.push({ id: c.id, name: c.name, isBot: false });
  }
  room.sim = createSim({ grid, lobby, players: fillWithBots(seated, CONFIG) });
  room.lastTick = performance.now();
  room.lastSnap = 0;
  broadcastLobby(room);
}

function handleInput(client, msg) {
  const room = client.room;
  if (!room || !room.sim || client.spectator) return;
  applyInput(room.sim, client.id, { yaw: msg.yaw, power: msg.power, lock: msg.lock });
}

function removeClient(client) {
  const room = client.room;
  if (!room) return;
  room.clients.delete(client.id);
  client.room = null;
  if (room.sim && matchActive(room)) convertToBot(room.sim, client.id);
  if (room.clients.size === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === client.id) room.hostId = room.clients.keys().next().value;
  broadcastLobby(room);
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048, perMessageDeflate: false });
wss.on('connection', (ws) => {
  const client = { id: `h${nextClientId++}`, ws, name: 'Duck', room: null, spectator: false, winStart: Date.now(), winCount: 0 };
  ws.on('message', (data) => {
    const now = Date.now();
    if (now - client.winStart >= 1000) {
      client.winStart = now;
      client.winCount = 0;
    }
    if (++client.winCount > MSG_PER_SECOND) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'join':
        handleJoin(client, msg);
        break;
      case 'start':
        handleStart(client);
        break;
      case 'in':
        handleInput(client, msg);
        break;
      default:
        break;
    }
  });
  ws.on('close', () => removeClient(client));
  ws.on('error', () => ws.terminate());
});

setInterval(() => {
  const now = performance.now();
  for (const room of rooms.values()) {
    if (!room.sim) continue;
    advance(room.sim, (now - room.lastTick) / 1000);
    room.lastTick = now;
    if (now - room.lastSnap >= 1000 / CONFIG.SNAPSHOT_HZ) {
      room.lastSnap = now;
      if (room.sim.phase === PHASE.GAMEOVER && !room.announcedEnd) {
        room.announcedEnd = true;
        broadcastLobby(room);
      } else if (room.sim.phase !== PHASE.GAMEOVER) {
        room.announcedEnd = false;
      }
      // One snapshot per client: other players' aim/power are hidden while planning.
      for (const c of room.clients.values()) send(c.ws, { t: 'snap', s: snapshot(room.sim, c.id, false) });
      room.sim.events = [];
    }
  }
}, 8);

server.listen(PORT, () => {
  console.log(`Tumbler listening on http://localhost:${PORT}  (grid: ${grid.tiles.length} tiles, top y=${grid.top})`);
});
