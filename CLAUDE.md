# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A zero-dependency Node.js server for playing card games with friends on a local network: 21 (blackjack), Texas Hold'em, and Five Card Draw. There is no `node_modules`, build step, bundler, linter, or test suite; the code uses only Node built-ins (`http`, `fs`, `path`, `crypto`, `os`) and plain browser JS.

## Commands

- `npm start` (or `node server.js`) starts the server on `PORT` (default 3000), bound to `0.0.0.0`. It prints the LAN URLs for friends to join.
- All game state is in memory, so restarting the server closes every room. Restart after any server-side change. Static files are served with `no-store`, so a browser refresh is enough for client changes.
- There are no tests. `poker.js` exports `evaluate`, `compare`, and `createGame`, so you can check hand evaluation from a one-off script, e.g. `node -e "const {evaluate}=require('./poker'); console.log(evaluate([...]))"`. Cards are `{ r: 'A', s: '♠' }`.
- To drive a whole table from a script, call `createGame(variant, { betting, room: { code, number } })`, then `connect(fakeRes, token)`, `join`, and `action(token, { type: 'deal' })`, and set cards directly on `table.players[i].cards` (the returned object exposes `table`). Each `fakeRes` needs a `write` method that records each view. Views are sent as SSE `data: <json>` messages, but the table also writes `: ping` keep-alives every 20s, so only parse lines that start with `data: `.

## Architecture

**Rooms (`server.js`)**: A host opens a room from the lobby (`POST /api/rooms` with `game`: `holdem` | `draw` | `21`, and `betting`). The room gets a random 4-letter code and the lowest free number from 1 to `MAX_ROOMS` (5). The room's betting mode is fixed when it is created. Friends join at `/room/<code>`, which serves `21.html` or `poker.html` depending on the room's game. Once a room has had no SSE connections for `ROOM_IDLE_MS` (60s), it closes. Visiting a closed or unknown room redirects to `/?gone=<code>`, and its API answers 404. `server.js` handles all HTTP: static files (a fixed `STATIC` map, so new public files must be added there), token and name validation, and the room routes `/api/rooms/<code>/events|join|action`. JSON body parsing and responses live in `http-util.js`.

**Tables**: `twentyone.js` (`createTwentyOne`) and `poker.js` (`createGame(variant, …)`) are closure-based factories. Both take `{ betting, room }`, and each call builds one independent table with its own state, SSE connections, and timers. They share a room interface and know nothing about HTTP: `connect(res, token)` returns a disconnect function, `join(token, name)`, `action(token, body)`, `connections()`, and `close()` (clears timers when the room expires). Poker variant differences are kept to the `VARIANTS` table plus phase checks (`predraw`/`draw`/`postdraw` vs `preflop`/`flop`/`turn`/`river`). Poker side pots are computed at showdown in `finish()` from each player's total `committed` chips, with one pot per distinct all-in level. `bet` is the per-street amount. In Draw, a player swaps up to `MAX_DISCARD` (3) cards, or `ACE_DISCARD` (4) if the one card they keep is an ace. That ace is then shown to the table through `shownCard`, and `view()` reveals it while the other cards stay hidden. The client repeats this check using `state.maxDiscard`/`state.aceDiscard` so it can show a toast, and it lets players pick their discards before their turn (tracked with the view's `drew` flag).

**Shared protocol (the same for every game):**
- Clients have no accounts. The browser generates a random 32-hex token kept in `localStorage` (`token21`) and sends it with every POST and as the `?token=` query on the SSE stream. The server identifies players by token. The public `id` is a separate UUID, so the token never leaves the server in views.
- State is pushed, never polled. After every successful mutation the table calls `broadcast()`, which sends each connection its own `view(token)` (other players' hole cards hidden, `room: { code, number }` included). The client re-renders everything from `state` on each message.
- Action handlers (`act`, `play`, `draw`, `startHand`, `join`) return an error string on failure and `undefined` on success. `server.js` turns the string into a `400 { error }`, which the client shows as a toast.
- A turn timer (`giveTurn`/`startTurnTimer`) auto-acts when a player runs out of time. Timeouts capture `handNo`/`round`, `phase`, and the turn so stale timers do nothing. Offline players get a shorter clock (poker) or are skipped (21), and players are pruned after 10 minutes offline when the next hand starts.
- Shuffling uses `crypto.randomInt` (Fisher–Yates).
- With `betting` off, chips are left untouched and players keep a win count instead. 21 deals in every online player and has no doubling. Hold'em skips the blinds and betting and runs the board out on a timer (`runOut`). Draw goes straight to the `draw` phase and then the showdown. Changes to the betting flow need to handle both modes.

**Client (`public/`)**: `index.html` is the lobby (create a room, or join by code). `common.js` holds the shared helpers: it reads `ROOM`/`API` from the `/room/<code>` URL and provides the token, `post`, the `el()` DOM builder, `cardEl`, `headerEl`, `joinEl`, `connect`, and the countdown `tick`. If the room has closed, `connect` sends the player back to the lobby. Each game page defines a global `render()` and calls `connect()`. `poker.html` serves both poker variants and picks one from `state.variant`. The UI is built imperatively with `el(tag, attrs, ...children)`, not with a framework.
