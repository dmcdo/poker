// Shared by the lobby and the game pages. Each game page defines render() and calls connect().
// Game pages live at /room/<code>; the room's API is under /api/rooms/<code>/.
const ROOM = location.pathname.split('/')[2]?.toUpperCase();
const API = `/api/rooms/${ROOM}`;

const token = (() => {
  let t = localStorage.getItem('token21');
  if (!t) {
    t = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('token21', t);
  }
  return t;
})();

let state = null;
let deadline = 0;
const app = document.getElementById('app');
const toastEl = document.getElementById('toast');
let toastTimer;

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 2500);
}

// Resolves to the response data, or null after showing the error.
async function post(path, body) {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, ...body }),
    });
    const data = await res.json();
    if (res.ok) return data;
    toast(data.error || 'Something went wrong');
  } catch {
    toast('Lost connection to the table');
  }
  return null;
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v);
  }
  node.append(...children.filter((c) => c != null && c !== false));
  return node;
}

// Clawd, drawn on a 14x8 pixel grid.
function clawdEl() {
  const t = document.createElement('template');
  t.innerHTML = `<svg class="clawd" viewBox="0 0 14 8" shape-rendering="crispEdges" role="img" aria-label="Clawd">
    <g fill="#d97757">
      <rect x="2" y="0" width="10" height="6"/>
      <rect x="0" y="3" width="2" height="2"/><rect x="12" y="3" width="2" height="2"/>
      <rect x="3" y="6" width="1" height="2"/><rect x="5" y="6" width="1" height="2"/>
      <rect x="8" y="6" width="1" height="2"/><rect x="10" y="6" width="1" height="2"/>
    </g>
    <rect x="4" y="2" width="1" height="2" fill="#1f1a17"/><rect x="9" y="2" width="1" height="2" fill="#1f1a17"/>
  </svg>`;
  return t.content.firstElementChild;
}

function cardEl(c) {
  if (c.hidden) return el('div', { class: 'card back' });
  const red = c.s === '♥' || c.s === '♦';
  return el('div', { class: 'card' + (red ? ' red' : '') }, el('span', {}, c.r), el('span', { class: 'suit' }, c.s));
}

// "Room 2 · Code KQTR · No betting", for headers and the join screen.
function roomLabel() {
  return `Room ${state.room.number} · Code ${state.room.code}` + (state.betting ? '' : ' · No betting');
}

// Page header: back link, title with the room underneath, and a leave button.
function headerEl(title, canLeave) {
  return el('header', {},
    el('a', { class: 'link', href: '/' }, '‹ Games'),
    el('div', { class: 'title' }, el('h1', {}, title), el('div', { class: 'label' }, roomLabel())),
    el('button', { class: 'link', disabled: !canLeave, onclick: () => post(`${API}/action`, { type: 'leave' }) }, 'Leave table'));
}

function joinEl(title) {
  const input = el('input', { placeholder: 'Your name', maxlength: 16, autocomplete: 'off', value: localStorage.getItem('name21') || '' });
  const submit = (e) => {
    e.preventDefault();
    const name = input.value.trim();
    if (!name) return toast('Enter a name');
    localStorage.setItem('name21', name);
    post(`${API}/join`, { name });
  };
  return el('form', { class: 'join', onsubmit: submit },
    clawdEl(),
    el('h1', {}, title),
    el('div', { class: 'label' }, roomLabel()),
    el('div', { class: 'label' }, state.players.length ? `${state.players.length} at the table` : 'The table is empty'),
    input,
    el('button', { class: 'primary' }, 'Sit down'),
    el('a', { class: 'link', href: '/' }, '‹ All games'));
}

function tick() {
  const t = document.getElementById('timer');
  if (t) t.textContent = Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) + 's';
}
setInterval(tick, 500);

function connect() {
  const source = new EventSource(`${API}/events?token=${token}`);
  source.onmessage = (e) => {
    state = JSON.parse(e.data);
    deadline = Date.now() + state.remaining;
    render();
  };
  // A closed room answers 404, which stops the stream for good instead of retrying.
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) location.href = `/?gone=${ROOM}`;
  };
}
