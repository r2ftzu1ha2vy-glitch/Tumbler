// Thin WebSocket wrapper. Protocol (JSON):
//   client -> server: {t:'join', room?, name} | {t:'start'} | {t:'in', yaw?, power?, lock?}
//   server -> client: {t:'joined', id, room} | {t:'lobby', ...} | {t:'snap', s} | {t:'error', msg}

export function openConnection({ onMessage, onClose }) {
  const url = new URL('ws', location.href); // relative to the page, so sub-path hosting works
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url);
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error('Could not reach the Tumbler server.')));
  });
  ws.addEventListener('message', (ev) => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (m && typeof m.t === 'string') onMessage(m);
  });
  ws.addEventListener('close', () => onClose?.());
  return {
    ready,
    send: (m) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    },
    close: () => ws.close(),
  };
}
