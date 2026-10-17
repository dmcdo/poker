// No-limit poker tables: Texas Hold'em and Five Card Draw.
// Each table's state is pushed to its players over Server-Sent Events.
const crypto = require('crypto');

const START_CHIPS = 1000;
const SMALL_BLIND = 5;
const BIG_BLIND = 10;
const TURN_MS = 60_000;
const AWAY_TURN_MS = 15_000;
const RUNOUT_MS = 1500;
const PRUNE_OFFLINE_MS = 10 * 60_000;
const MAX_DISCARD = 3;
// A player keeping an ace may swap the other four, but must show the ace.
const ACE_DISCARD = 4;

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const HAND_NAMES = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Four of a kind', 'Straight flush'];

// Draw is capped at 6 seats so the deck always covers 5 cards plus 3 replacements each.
const VARIANTS = {
  holdem: { holeCards: 2, maxPlayers: 8, firstPhase: 'preflop' },
  draw: { holeCards: 5, maxPlayers: 6, firstPhase: 'predraw' },
};
const NEXT_PHASE = { preflop: 'flop', flop: 'turn', turn: 'river' };

// ---------- cards ----------

function freshDeck() {
  const deck = [];
  for (const s of ['♠', '♥', '♦', '♣']) for (const r of RANKS) deck.push({ r, s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

const value = (c) => RANKS.indexOf(c.r) + 2;
const desc = (a, b) => b - a;

function straightHigh(vals) {
  const set = new Set(vals);
  if (set.has(14)) set.add(1);
  for (let hi = 14; hi >= 5; hi--) if ([0, 1, 2, 3, 4].every((d) => set.has(hi - d))) return hi;
  return 0;
}

// Best five-card hand from 5-7 cards, as [category, ...tiebreakers]; compare() orders them.
function evaluate(cards) {
  const vals = cards.map(value).sort(desc);
  const bySuit = {};
  for (const c of cards) (bySuit[c.s] ||= []).push(value(c));
  const flush = Object.values(bySuit).find((v) => v.length >= 5)?.sort(desc);
  if (flush) {
    const hi = straightHigh(flush);
    if (hi) return [8, hi];
  }

  const counts = new Map();
  for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
  const atLeast = (n) => [...counts].filter(([, c]) => c >= n).map(([v]) => v).sort(desc);
  const kickers = (used, n) => [...new Set(vals)].filter((v) => !used.includes(v)).slice(0, n);
  const quads = atLeast(4);
  const trips = atLeast(3);
  const pairs = atLeast(2);

  if (quads.length) return [7, quads[0], ...kickers([quads[0]], 1)];
  if (trips.length && pairs.length > 1) return [6, trips[0], pairs.find((v) => v !== trips[0])];
  if (flush) return [5, ...flush.slice(0, 5)];
  const hi = straightHigh(vals);
  if (hi) return [4, hi];
  if (trips.length) return [3, trips[0], ...kickers([trips[0]], 2)];
  if (pairs.length > 1) return [2, pairs[0], pairs[1], ...kickers(pairs.slice(0, 2), 1)];
  if (pairs.length) return [1, pairs[0], ...kickers([pairs[0]], 3)];
  return [0, ...vals.slice(0, 5)];
}

function compare(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

// ---------- one table ----------

// `variant` is a key of VARIANTS. `betting` false skips blinds and betting rounds, and hands are played
// for wins only. `room` is passed through to views. server.js gives each room its own table.
function createGame(variant, { betting, room }) {
  const rules = VARIANTS[variant];
  const table = {
    phase: 'waiting', // 'waiting', then preflop/flop/turn/river or predraw/draw/postdraw
    betting,
    players: [],
    board: [],
    deck: [],
    buttonId: null,
    turnId: null,
    currentBet: 0, // highest bet on this street
    minRaise: BIG_BLIND, // size of the last full raise
    deadline: 0,
    handNo: 0,
    message: '',
  };
  let conns = []; // { res, token }
  let turnTimer = null;
  const pinger = setInterval(() => { for (const c of conns) c.res.write(': ping\n\n'); }, 20_000);

  const isOnline = (p) => conns.some((c) => c.token === p.token);
  const live = () => table.players.filter((p) => p.inHand && !p.folded);
  const pot = () => table.players.reduce((sum, p) => sum + p.committed, 0);
  const needsAction = (p) => p.inHand && !p.folded && !p.allIn && (!p.acted || p.bet < table.currentBet);
  const hasOpponentToBet = (p) => live().some((q) => q !== p && !q.allIn);

  // Seat order starting with the seat after `id` and ending with `id` itself.
  function after(id) {
    const i = table.players.findIndex((p) => p.id === id);
    return [...table.players.slice(i + 1), ...table.players.slice(0, i + 1)];
  }

  function put(p, amount) {
    const a = Math.min(amount, p.chips);
    p.chips -= a;
    p.bet += a;
    p.committed += a;
    if (p.chips === 0) p.allIn = true;
  }

  // Gives `p` the turn; `onTimeout` plays for them if the clock runs out.
  function giveTurn(p, onTimeout) {
    table.turnId = p.id;
    const ms = isOnline(p) ? TURN_MS : AWAY_TURN_MS;
    table.deadline = Date.now() + ms;
    const { handNo, phase } = table;
    turnTimer = setTimeout(() => {
      if (table.handNo !== handNo || table.phase !== phase || table.turnId !== p.id) return;
      onTimeout();
      broadcast();
    }, ms);
  }

  // Returns an error string, or nothing on success.
  function startHand() {
    const now = Date.now();
    table.players = table.players.filter((p) => isOnline(p) || now - p.offlineSince < PRUNE_OFFLINE_MS);
    const dealt = table.players.filter((p) => isOnline(p) && (p.chips > 0 || !table.betting));
    if (dealt.length < 2) return table.betting ? 'Need at least two players with chips' : 'Need at least two players';

    for (const p of table.players) {
      Object.assign(p, {
        cards: [], bet: 0, committed: 0, folded: false, allIn: false, acted: false, drew: false,
        show: false, shownCard: -1, lastAction: '', won: 0, winner: false, handName: '', score: null, inHand: dealt.includes(p),
      });
    }
    table.deck = freshDeck();
    table.board = [];
    table.message = '';
    table.turnId = null;
    table.handNo++;

    const button = after(table.buttonId).find((p) => p.inHand);
    table.buttonId = button.id;
    const order = after(button.id).filter((p) => p.inHand); // button is last

    if (!table.betting) {
      for (let i = 0; i < rules.holeCards; i++) for (const p of order) p.cards.push(table.deck.pop());
      table.currentBet = 0;
      if (rules.firstPhase === 'predraw') {
        table.phase = 'draw';
        return nextDrawer(button.id);
      }
      table.phase = rules.firstPhase;
      return runOut();
    }
    // Heads-up, the button posts the small blind and acts first on the opening round.
    const sb = order.length === 2 ? button : order[0];
    const bb = order.length === 2 ? order[0] : order[1];
    put(sb, SMALL_BLIND);
    put(bb, BIG_BLIND);
    sb.lastAction = 'Small blind';
    bb.lastAction = 'Big blind';
    for (let i = 0; i < rules.holeCards; i++) for (const p of order) p.cards.push(table.deck.pop());

    table.phase = rules.firstPhase;
    table.currentBet = BIG_BLIND;
    table.minRaise = BIG_BLIND;
    next(bb.id);
  }

  // Hands the turn to whoever bets after `fromId`, or moves the hand along if betting is done.
  function next(fromId) {
    clearTimeout(turnTimer);
    const inPlay = live();
    if (inPlay.length === 1) return finish();
    const able = inPlay.filter((p) => !p.allIn);
    const settled = able.length <= 1 && able.every((p) => p.bet >= table.currentBet);
    const p = settled ? null : after(fromId).find(needsAction);
    if (!p) return nextStreet();
    giveTurn(p, () => {
      play(p, p.bet >= table.currentBet ? 'check' : 'fold');
      next(p.id);
    });
  }

  function startBettingRound(phase) {
    for (const p of table.players) {
      p.bet = 0;
      p.acted = false;
    }
    table.currentBet = 0;
    table.minRaise = BIG_BLIND;
    table.phase = phase;
    if (!table.betting) return runOut();
    next(table.buttonId);
  }

  // Without betting, the board comes out on its own, one street at a time.
  function runOut() {
    clearTimeout(turnTimer);
    const { handNo } = table;
    turnTimer = setTimeout(() => {
      if (table.handNo !== handNo) return;
      nextStreet();
      broadcast();
    }, RUNOUT_MS);
  }

  function nextStreet() {
    for (const p of table.players) if (!p.folded && !p.allIn) p.lastAction = '';
    if (table.phase === 'river' || table.phase === 'postdraw') return finish();
    if (table.phase === 'predraw') {
      table.phase = 'draw';
      return nextDrawer(table.buttonId);
    }
    const n = table.phase === 'preflop' ? 3 : 1;
    for (let i = 0; i < n; i++) table.board.push(table.deck.pop());
    startBettingRound(NEXT_PHASE[table.phase]);
  }

  // Draw phase: everyone still in, all-in or not, swaps cards in seat order.
  function nextDrawer(fromId) {
    clearTimeout(turnTimer);
    const p = after(fromId).find((q) => q.inHand && !q.folded && !q.drew);
    if (!p) return table.betting ? startBettingRound('postdraw') : finish();
    giveTurn(p, () => {
      draw(p, []);
      nextDrawer(p.id);
    });
  }

  // Swaps the cards at `indexes` for new ones. Returns an error string, or nothing.
  // Swapping ACE_DISCARD cards is allowed only if the one card kept is an ace, which is then shown.
  function draw(p, indexes) {
    const valid = Array.isArray(indexes) && indexes.length <= ACE_DISCARD
      && new Set(indexes).size === indexes.length
      && indexes.every((i) => Number.isInteger(i) && i >= 0 && i < p.cards.length);
    if (!valid) return `Pick up to ${MAX_DISCARD} cards to swap`;
    const kept = p.cards.findIndex((c, i) => !indexes.includes(i));
    const showAce = indexes.length > MAX_DISCARD;
    if (showAce && p.cards[kept].r !== 'A') return `You can swap ${ACE_DISCARD} only if you keep an ace`;
    for (const i of indexes) p.cards[i] = table.deck.pop();
    p.drew = true;
    if (showAce) p.shownCard = kept;
    p.lastAction = indexes.length ? `Drew ${indexes.length}` + (showAce ? ' · showed ace' : '') : 'Stood pat';
  }

  function finish() {
    clearTimeout(turnTimer);
    const inHand = table.players.filter((p) => p.inHand);
    const inPlay = live();

    // Return the uncalled part of the biggest bet.
    const [top, second] = [...inHand].sort((a, b) => b.committed - a.committed);
    const uncalled = top.committed - second.committed;
    top.chips += uncalled;
    top.committed -= uncalled;

    if (inPlay.length === 1) {
      const winner = inPlay[0];
      winner.won = pot();
      winner.chips += winner.won;
      table.message = `${winner.name} wins ${winner.won}`;
    } else {
      for (const p of inPlay) {
        p.score = evaluate([...p.cards, ...table.board]);
        p.handName = HAND_NAMES[p.score[0]];
        p.show = true;
      }
      if (!table.betting) {
        const best = inPlay.reduce((m, p) => (compare(p.score, m) > 0 ? p.score : m), inPlay[0].score);
        const winners = inPlay.filter((p) => compare(p.score, best) === 0);
        for (const w of winners) { w.winner = true; w.wins++; }
        table.message = `${winners.map((w) => w.name).join(' & ')} ${winners.length > 1 ? 'split' : 'wins'} with ${winners[0].handName}`;
      } else {
        // One pot per distinct all-in level; each goes to the best hand that paid into it.
        const levels = [...new Set(inPlay.map((p) => p.committed))].sort((a, b) => a - b);
        const seatOrder = after(table.buttonId);
        let prev = 0;
        for (const level of levels) {
          const amount = inHand.reduce((sum, p) => sum + Math.min(p.committed, level) - Math.min(p.committed, prev), 0);
          const eligible = inPlay.filter((p) => p.committed >= level);
          const best = eligible.reduce((m, p) => (compare(p.score, m) > 0 ? p.score : m), eligible[0].score);
          const winners = seatOrder.filter((p) => eligible.includes(p) && compare(p.score, best) === 0);
          const share = Math.floor(amount / winners.length);
          let odd = amount % winners.length; // odd chips go to the first seats left of the button
          for (const w of winners) {
            const chips = share + (odd-- > 0 ? 1 : 0);
            w.chips += chips;
            w.won += chips;
          }
          prev = level;
        }
        table.message = inPlay.filter((p) => p.won > 0).map((p) => `${p.name} wins ${p.won} with ${p.handName}`).join(' · ');
      }
    }

    for (const p of inPlay) p.lastAction = '';
    table.phase = 'waiting';
    table.turnId = null;
  }

  // Applies a betting action for the player whose turn it is. Returns an error string, or nothing.
  function play(p, type, amount) {
    const toCall = Math.min(table.currentBet - p.bet, p.chips);
    switch (type) {
      case 'fold':
        p.folded = true;
        p.lastAction = 'Fold';
        break;
      case 'check':
        if (toCall > 0) return 'You need to call or fold';
        p.lastAction = 'Check';
        break;
      case 'call':
        if (toCall <= 0) return 'Nothing to call';
        put(p, toCall);
        p.lastAction = p.allIn ? 'All-in' : `Call ${toCall}`;
        break;
      case 'raise': {
        const max = p.bet + p.chips;
        // A short all-in does not reopen the betting for players who already acted.
        if (p.acted || !hasOpponentToBet(p)) return 'You can only call or fold';
        if (!Number.isInteger(amount) || amount <= table.currentBet || amount > max) return 'Invalid amount';
        const size = amount - table.currentBet;
        if (size < table.minRaise && amount !== max) return `Minimum is ${table.currentBet + table.minRaise}`;
        const opening = table.currentBet === 0;
        put(p, amount - p.bet);
        if (size >= table.minRaise) {
          table.minRaise = size;
          for (const q of table.players) q.acted = false;
        }
        table.currentBet = amount;
        p.lastAction = p.allIn ? `All-in ${amount}` : opening ? `Bet ${amount}` : `Raise to ${amount}`;
        break;
      }
      default:
        return 'Unknown action';
    }
    p.acted = true;
  }

  // Returns an error string, or nothing on success.
  function act(p, { type, amount, cards }) {
    const waiting = table.phase === 'waiting';
    switch (type) {
      case 'deal':
        if (!waiting) return 'Hand in progress';
        return startHand();
      case 'rebuy':
        if (!waiting) return 'Wait for the hand to finish';
        if (!table.betting) return 'Betting is off';
        if (p.chips > 0) return 'You still have chips';
        p.chips = START_CHIPS;
        return;
      case 'leave':
        if (!waiting) return 'Wait for the hand to finish';
        table.players = table.players.filter((q) => q !== p);
        return;
      default: {
        if (waiting || table.turnId !== p.id) return 'Not your turn';
        const drawing = table.phase === 'draw';
        if (drawing !== (type === 'draw')) return drawing ? 'Swap your cards first' : 'Not the draw round';
        const error = drawing ? draw(p, cards) : play(p, type, amount);
        if (error) return error;
        if (drawing) nextDrawer(p.id);
        else next(p.id);
      }
    }
  }

  // ---------- state push ----------

  function view(token) {
    const me = table.players.find((p) => p.token === token);
    const playing = table.phase !== 'waiting';
    let options = null;
    if (playing && table.phase !== 'draw' && me && table.turnId === me.id) {
      const max = me.bet + me.chips;
      options = {
        toCall: Math.min(table.currentBet - me.bet, me.chips),
        canRaise: !me.acted && max > table.currentBet && hasOpponentToBet(me),
        minRaiseTo: Math.min(table.currentBet + table.minRaise, max),
        maxRaiseTo: max,
      };
    }
    return {
      you: me ? me.id : null,
      room,
      variant,
      phase: table.phase,
      betting: table.betting,
      handNo: table.handNo,
      board: table.board,
      pot: pot(),
      currentBet: table.currentBet,
      bigBlind: BIG_BLIND,
      maxDiscard: MAX_DISCARD,
      aceDiscard: ACE_DISCARD,
      buttonId: table.buttonId,
      turn: playing ? table.turnId : null,
      remaining: playing ? Math.max(0, table.deadline - Date.now()) : 0,
      message: table.message,
      options,
      players: table.players.map((p) => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        bet: p.bet,
        inHand: p.inHand,
        folded: p.folded,
        allIn: p.allIn,
        drew: p.drew,
        lastAction: p.lastAction,
        won: p.won,
        winner: p.winner,
        wins: p.wins,
        handName: p.handName,
        online: isOnline(p),
        cards: p === me || p.show ? p.cards : p.folded ? [] : p.cards.map((c, i) => (i === p.shownCard ? c : { hidden: true })),
      })),
    };
  }

  function broadcast() {
    for (const c of conns) c.res.write(`data: ${JSON.stringify(view(c.token))}\n\n`);
  }

  // ---------- room interface (see server.js) ----------

  // Adds an open SSE response; returns a function to call when it closes.
  function connect(res, token) {
    const conn = { res, token };
    conns.push(conn);
    broadcast();
    return () => {
      conns = conns.filter((c) => c !== conn);
      const p = table.players.find((q) => q.token === token);
      if (p && !isOnline(p)) p.offlineSince = Date.now();
      broadcast();
    };
  }

  // Seats a new player, or renames one already seated. Returns an error string, or nothing.
  function join(token, name) {
    const p = table.players.find((q) => q.token === token);
    if (p) p.name = name;
    else {
      if (table.players.length >= rules.maxPlayers) return 'Table is full';
      table.players.push({
        id: crypto.randomUUID(), token, name, chips: START_CHIPS,
        cards: [], bet: 0, committed: 0, inHand: false, folded: false, allIn: false, acted: false, drew: false,
        show: false, shownCard: -1, lastAction: '', won: 0, winner: false, wins: 0, handName: '', score: null, offlineSince: Date.now(),
      });
    }
    broadcast();
  }

  // Returns an error string, or nothing on success.
  function action(token, body) {
    const p = table.players.find((q) => q.token === token);
    if (!p) return 'Join the table first';
    const error = act(p, body);
    if (!error) broadcast();
    return error;
  }

  function close() {
    clearTimeout(turnTimer);
    clearInterval(pinger);
  }

  return { connect, join, action, close, connections: () => conns.length, table, finish };
}

module.exports = { createGame, evaluate, compare };
