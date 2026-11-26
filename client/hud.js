// DOM overlay: menu, lobby, in-game HUD (banner, roster, power bar), end card.
// Pure presentation: it is told what to show and reports button clicks through `el`.
import { CONFIG, PLAYER_COLORS } from '../shared/config.js';
import { slideDistance } from '../shared/rules.js';

const $ = (id) => document.getElementById(id);

export function createHud() {
  const el = {
    hud: $('hud'), menu: $('menu'), lobby: $('lobby'), end: $('end'), fatal: $('fatal'),
    phase: $('phase'), sub: $('sub'), timerfill: $('timerfill'), roster: $('roster'),
    power: $('power'), pwUp: $('pwUp'), pwDown: $('pwDown'), pwFill: $('pwFill'), pwPct: $('pwPct'), pwDist: $('pwDist'),
    launch: $('launch'), bigcount: $('bigcount'),
    nameInput: $('nameInput'), codeInput: $('codeInput'), btnOffline: $('btnOffline'), btnCreate: $('btnCreate'),
    btnJoin: $('btnJoin'), menuStatus: $('menuStatus'),
    lobbyCode: $('lobbyCode'), lobbyShare: $('lobbyShare'), lobbyList: $('lobbyList'), lobbyNote: $('lobbyNote'),
    lobbyStart: $('lobbyStart'), lobbyLeave: $('lobbyLeave'),
    endTitle: $('endTitle'), endSub: $('endSub'), endAgain: $('endAgain'), endMenu: $('endMenu'),
  };

  const cache = new Map(); // avoids touching the DOM when nothing changed
  const setText = (key, node, text) => {
    if (cache.get(key) === text) return;
    cache.set(key, text);
    node.textContent = text;
  };

  function setStatus(text, isError = false) {
    el.menuStatus.textContent = text;
    el.menuStatus.classList.toggle('err', isError);
  }

  function setMenuEnabled(on) {
    el.btnOffline.disabled = !on;
    el.btnCreate.disabled = !on;
    el.btnJoin.disabled = !on;
  }

  function showMenu(message = '', isError = false) {
    el.hud.hidden = true;
    el.lobby.hidden = true;
    el.end.hidden = true;
    el.menu.hidden = false;
    setStatus(message, isError);
  }

  function showLobby({ code, players, hostId, myId, maxPlayers }) {
    el.menu.hidden = true;
    el.hud.hidden = true;
    el.end.hidden = true;
    el.lobby.hidden = false;
    el.lobbyCode.textContent = code;
    el.lobbyShare.textContent = `Share this link: ${location.origin}${location.pathname}?room=${code}`;
    el.lobbyList.replaceChildren();
    const seated = players.filter((p) => !p.spectator);
    for (const p of players) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = p.name + (p.id === myId ? ' (you)' : '');
      li.append(name);
      const tag = document.createElement('span');
      tag.className = 'tagchip';
      tag.textContent = [p.id === hostId ? 'host' : '', p.spectator ? 'spectating' : ''].filter(Boolean).join(' · ');
      li.append(tag);
      el.lobbyList.append(li);
    }
    const bots = Math.max(0, maxPlayers - seated.length);
    el.lobbyNote.textContent = `${seated.length} duck${seated.length === 1 ? '' : 's'} in, ${bots} bot${bots === 1 ? '' : 's'} will fill the rest.`;
    const isHost = hostId === myId;
    el.lobbyStart.disabled = !isHost;
    el.lobbyStart.textContent = isHost ? 'Start match' : 'Waiting for host…';
  }

  function showEnd({ title, sub, canAgain, againLabel }) {
    el.endTitle.textContent = title;
    el.endSub.textContent = sub;
    setEndAction(canAgain, againLabel);
    el.end.hidden = false;
  }
  function setEndAction(canAgain, label) {
    el.endAgain.disabled = !canAgain;
    el.endAgain.textContent = canAgain ? 'Play again' : label;
  }
  const hideEnd = () => { el.end.hidden = true; };
  const isEndShown = () => !el.end.hidden;

  function fatal(message) {
    $('fatalMsg').textContent = message;
    el.fatal.hidden = false;
    el.menu.hidden = true;
  }

  function rosterRows(state, myId) {
    const sig = `${state.phase}|${myId}|` + state.players.map((p) => `${p.id}:${p.alive}:${p.locked}`).join(',');
    if (cache.get('rosterSig') === sig) return;
    cache.set('rosterSig', sig);
    el.roster.replaceChildren();
    for (const p of state.players) {
      const row = document.createElement('div');
      row.className = 'rrow' + (p.alive ? '' : ' out') + (p.id === myId ? ' me' : '') + (p.alive && p.locked ? ' ready' : '');
      const dot = document.createElement('span');
      dot.className = 'dot';
      dot.style.background = PLAYER_COLORS[p.ci % PLAYER_COLORS.length];
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = p.name;
      const st = document.createElement('span');
      st.className = 'st';
      if (!p.alive) st.textContent = 'out';
      else if (state.phase === 'planning') st.textContent = p.locked ? 'ready' : 'aiming';
      row.append(dot, nm, st);
      el.roster.append(row);
    }
  }

  // ctx: { me, myId, power, locked }
  function update(state, ctx) {
    el.hud.hidden = false;
    const { me, myId } = ctx;
    rosterRows(state, myId);

    const secs = Math.ceil(state.timer);
    let phase = '';
    let sub = '';
    let big = '';
    let frac = 0;
    switch (state.phase) {
      case 'countdown':
        phase = 'Get ready!';
        sub = `Teleporting onto the grid in ${secs}…`;
        big = String(Math.max(1, secs));
        frac = state.timer / CONFIG.COUNTDOWN_S;
        break;
      case 'planning':
        phase = `Round ${state.round}: aim and set your power`;
        frac = state.timer / state.planTime;
        if (!me) sub = 'Spectating';
        else if (!me.alive) sub = "You're out. Watching the rest…";
        else sub = ctx.locked ? 'Locked in. Waiting for the others…' : `Launching in ${secs}s, or lock in with Space`;
        break;
      case 'sliding':
        phase = 'Sliiiide!';
        break;
      default:
        phase = 'Match over';
        break;
    }
    setText('phase', el.phase, phase);
    setText('sub', el.sub, sub);
    setText('big', el.bigcount, big);
    const w = `${Math.max(0, Math.min(1, frac)) * 100}%`;
    if (cache.get('tw') !== w) {
      cache.set('tw', w);
      el.timerfill.style.width = w;
    }

    const canAct = !!me && me.alive && state.phase === 'planning';
    el.power.classList.toggle('disabled', !canAct || ctx.locked);
    const pct = `${Math.round(ctx.power * 100)}%`;
    setText('pct', el.pwPct, pct);
    setText('dist', el.pwDist, `${slideDistance(ctx.power).toFixed(1)} m`);
    el.pwFill.style.height = pct;
    el.pwFill.style.background = `hsl(${Math.round((1 - ctx.power) * 95)} 85% 55%)`;
    setText('launch', el.launch.firstChild, ctx.locked && canAct ? 'Unlock ' : 'Launch ');
    el.launch.disabled = !canAct;
  }

  return { el, setStatus, setMenuEnabled, showMenu, showLobby, showEnd, setEndAction, hideEnd, isEndShown, fatal, update,
    hideMenu: () => { el.menu.hidden = true; }, hideLobby: () => { el.lobby.hidden = true; },
    showHud: (on) => { el.hud.hidden = !on; } };
}
