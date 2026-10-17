// Card games with friends — zero-dependency Node server.
// This file serves the pages and runs the rooms. A host opens a room for one game, with or without
// betting, and friends join it by its code. Each room has its own table from twentyone.js or poker.js,
// whose state is pushed to browsers over Server-Sent Events.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { createTwentyOne } = require('./twentyone');
const { createGame } = require('./poker');
const { readJson, sendJson } = require('./http-util');

const PORT = Number(process.env.PORT) || 3000;
const MAX_ROOMS = 5;
const ROOM_IDLE_MS = 60_000; // a room closes once nobody has been connected for this long
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, which look like 1 and 0
const CODE_LENGTH = 4;

const GAMES = {
  holdem: { page: 'poker.html', create: (opts) => createGame('holdem', opts) },
  draw: { page: 'poker.html', create: (opts) => createGame('draw', opts) },
  21: { page: '21.html', create: createTwentyOne },
};

const rooms = new Map(); // code -> { code, number, game, table, idleTimer }

// ---------- rooms ----------

// Returns the new room, or null when every room is taken.
function openRoom(game, betting) {
  if (rooms.size >= MAX_ROOMS) return null;
  const taken = new Set([...rooms.values()].map((r) => r.number));
  let number = 1;
  while (taken.has(number)) number++;
  let code;
  do code = Array.from({ length: CODE_LENGTH }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  while (rooms.has(code));

  const room = { code, number, game, idleTimer: null };
  room.table = GAMES[game].create({ betting, room: { code, number } });
  rooms.set(code, room);
  watchIdle(room); // the host may never arrive
  return room;
}

// Starts the countdown to close `room` if nobody is connected to it.
function watchIdle(room) {
  clearTimeout(room.idleTimer);
  if (rooms.get(room.code) !== room || room.table.connections() > 0) return;
  room.idleTimer = setTimeout(() => {
    if (room.table.connections() > 0) return;
    room.table.close();
    rooms.delete(room.code);
  }, ROOM_IDLE_MS);
}

// ---------- http ----------

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/common.js': ['common.js', 'text/javascript; charset=utf-8'],
};

function sendFile(res, file, type) {
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  fs.createReadStream(path.join(__dirname, 'public', file)).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && STATIC[url.pathname]) return sendFile(res, ...STATIC[url.pathname]);

  // Room pages: /room/ABCD. An unknown or closed room sends you back to the lobby.
  const page = url.pathname.match(/^\/room\/([A-Za-z]+)$/);
  if (req.method === 'GET' && page) {
    const code = page[1].toUpperCase();
    const room = rooms.get(code);
    if (!room) {
      res.writeHead(302, { Location: `/?gone=${code}` });
      return res.end();
    }
    return sendFile(res, GAMES[room.game].page, 'text/html; charset=utf-8');
  }

  if (url.pathname === '/api/rooms') {
    if (req.method === 'GET') return sendJson(res, 200, { open: rooms.size, max: MAX_ROOMS });
    if (req.method === 'POST') {
      let body;
      try { body = await readJson(req); } catch { return sendJson(res, 400, { error: 'Bad request' }); }
      if (!Object.hasOwn(GAMES, body.game)) return sendJson(res, 400, { error: 'Pick a game' });
      const room = openRoom(body.game, body.betting !== false);
      if (!room) return sendJson(res, 503, { error: `All ${MAX_ROOMS} rooms are in use. Try again soon.` });
      return sendJson(res, 200, { code: room.code, number: room.number });
    }
  }

  const api = url.pathname.match(/^\/api\/rooms\/([A-Z]+)\/(events|join|action)$/);
  const room = api && rooms.get(api[1]);
  if (api && !room) return sendJson(res, 404, { error: 'This room has closed' });

  if (api && req.method === 'GET' && api[2] === 'events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // stop reverse proxies (e.g. on Render) from buffering the stream
    });
    clearTimeout(room.idleTimer);
    const disconnect = room.table.connect(res, url.searchParams.get('token') || '');
    req.on('close', () => {
      disconnect();
      watchIdle(room);
    });
    return;
  }

  if (api && req.method === 'POST' && api[2] !== 'events') {
    let body;
    try { body = await readJson(req); } catch { return sendJson(res, 400, { error: 'Bad request' }); }
    const token = typeof body.token === 'string' ? body.token : '';
    if (token.length < 16) return sendJson(res, 400, { error: 'Bad token' });

    let error;
    if (api[2] === 'join') {
      const name = String(body.name || '').trim().slice(0, 16);
      error = name ? room.table.join(token, name) : 'Enter a name';
    } else {
      error = room.table.action(token, body);
    }
    return error ? sendJson(res, 400, { error }) : sendJson(res, 200, { ok: true });
  }

  res.writeHead(404);
  res.end('Not found');
});

// Outlast the hosting load balancer's idle timeout so it never reuses a socket Node has closed.
server.keepAliveTimeout = 120_000;
server.headersTimeout = 121_000;

server.listen(PORT, '0.0.0.0', () => {
  if (process.env.RENDER_EXTERNAL_URL) return console.log(`Card table is running at ${process.env.RENDER_EXTERNAL_URL}`);
  console.log(`Card table is running. On this device: http://localhost:${PORT}`);
  try {
    for (const addrs of Object.values(os.networkInterfaces()))
      for (const a of addrs)
        if (a.family === 'IPv4' && !a.internal) console.log(`Friends on your network: http://${a.address}:${PORT}`);
  } catch {
    console.log(`Friends on your network: http://<this device's Wi-Fi IP>:${PORT}`);
  }
});
