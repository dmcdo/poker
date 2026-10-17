// 21 against Clawd the dealer. createTwentyOne() builds one table; server.js gives each room its own.
const crypto = require('crypto');

const START_CHIPS = 1000;
const MIN_BET = 10;
const MAX_PLAYERS = 7;
const DECKS = 4;
const TURN_MS = 45_000;
const PRUNE_OFFLINE_MS = 10 * 60_000;

// ---------- cards ----------

function freshShoe() {
  const shoe = [];
  for (let d = 0; d < DECKS; d++)
    for (const s of ['♠', '♥', '♦', '♣'])
      for (const r of ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'])
        shoe.push({ r, s });
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

function total(hand) {
  let sum = 0;
  let aces = 0;
  for (const c of hand) {
    if (c.r === 'A') { aces++; sum += 11; }
    else if ('JQK'.includes(c.r)) sum += 10;
    else sum += Number(c.r);
  }
  while (sum > 21 && aces > 0) { sum -= 10; aces--; }
  return sum;
}

const isBlackjack = (hand) => hand.length === 2 && total(hand) === 21;

// ---------- one table ----------

// `betting` false plays for wins only, with no chips changing hands. `room` is passed through to views.
function createTwentyOne({ betting, room }) {
  const table = {
    phase: 'betting', // 'betting' | 'playing'
    betting,
    players: [],
    dealer: [],
    shoe: [],
    turn: -1,
    deadline: 0,
    round: 0,
  };
  let conns = []; // { res, token }
  let turnTimer = null;
  const pinger = setInterval(() => { for (const c of conns) c.res.write(': ping\n\n'); }, 20_000);

  function draw() {
    if (table.shoe.length === 0) table.shoe = freshShoe();
    return table.shoe.pop();
  }

  const isOnline = (p) => conns.some((c) => c.token === p.token);

  function deal() {
    const now = Date.now();
    table.players = table.players.filter(
      (p) => p.bet > 0 || isOnline(p) || now - p.offlineSince < PRUNE_OFFLINE_MS
    );
    if (table.shoe.length < 60) table.shoe = freshShoe();

    table.round++;
    table.phase = 'playing';
    table.dealer = [];
    // Without betting, everyone at the table and online is dealt in.
    for (const p of table.players) {
      p.hand = [];
      p.result = null;
      p.status = (table.betting ? p.bet > 0 : isOnline(p)) ? 'playing' : 'out';
    }
    const active = table.players.filter((p) => p.status === 'playing');
    for (let i = 0; i < 2; i++) {
      for (const p of active) p.hand.push(draw());
      table.dealer.push(draw());
    }
    for (const p of active) if (isBlackjack(p.hand)) p.status = 'blackjack';

    // Dealer peeks: a natural ends the round before anyone acts.
    if (isBlackjack(table.dealer)) return settle();
    table.turn = -1;
    advance();
  }

  function advance() {
    clearTimeout(turnTimer);
    for (let i = table.turn + 1; i < table.players.length; i++) {
      const p = table.players[i];
      if (p.status !== 'playing') continue;
      if (!isOnline(p)) { p.status = 'stand'; continue; }
      table.turn = i;
      startTurnTimer();
      return;
    }
    dealerPlay();
  }

  function startTurnTimer() {
    clearTimeout(turnTimer);
    table.deadline = Date.now() + TURN_MS;
    const { round, turn } = table;
    turnTimer = setTimeout(() => {
      if (table.phase !== 'playing' || table.round !== round || table.turn !== turn) return;
      table.players[turn].status = 'stand';
      advance();
      broadcast();
    }, TURN_MS);
  }

  function dealerPlay() {
    const contested = table.players.some((p) => p.status === 'stand');
    if (contested) while (total(table.dealer) < 17) table.dealer.push(draw());
    settle();
  }

  function settle() {
    clearTimeout(turnTimer);
    const d = total(table.dealer);
    const dealerBJ = isBlackjack(table.dealer);
    for (const p of table.players) {
      if (p.status === 'out') continue;
      const t = total(p.hand);
      let outcome, payout;
      if (p.status === 'bust') { outcome = 'lose'; payout = 0; }
      else if (p.status === 'blackjack') {
        if (dealerBJ) { outcome = 'push'; payout = p.bet; }
        else { outcome = 'blackjack'; payout = p.bet + Math.floor(p.bet * 1.5); }
      }
      else if (dealerBJ) { outcome = 'lose'; payout = 0; }
      else if (d > 21 || t > d) { outcome = 'win'; payout = p.bet * 2; }
      else if (t === d) { outcome = 'push'; payout = p.bet; }
      else { outcome = 'lose'; payout = 0; }
      if (table.betting) {
        p.chips += payout;
        p.result = { outcome, delta: payout - p.bet };
        p.lastBet = p.doubled ? p.bet / 2 : p.bet;
      } else {
        p.result = { outcome, delta: 0 };
        if (outcome === 'win' || outcome === 'blackjack') p.wins++;
        else if (outcome === 'lose') p.losses++;
      }
      p.bet = 0;
      p.doubled = false;
    }
    table.phase = 'betting';
    table.turn = -1;
  }

  // Returns an error string, or nothing on success.
  function act(p, { type, amount }) {
    const betting = table.phase === 'betting';
    const myTurn = table.phase === 'playing' && table.players[table.turn] === p;

    switch (type) {
      case 'bet': {
        if (!betting) return 'Round in progress';
        if (!table.betting) return 'Betting is off';
        if (!Number.isInteger(amount) || amount < 0) return 'Invalid bet';
        if (amount !== 0 && amount < MIN_BET) return `Minimum bet is ${MIN_BET}`;
        if (amount > p.chips + p.bet) return 'Not enough chips';
        p.chips += p.bet - amount;
        p.bet = amount;
        return;
      }
      case 'rebuy': {
        if (!betting) return 'Round in progress';
        if (!table.betting) return 'Betting is off';
        if (p.chips + p.bet >= MIN_BET) return 'You still have chips';
        p.chips = START_CHIPS;
        p.bet = 0;
        return;
      }
      case 'deal': {
        if (!betting) return 'Round in progress';
        if (table.betting && p.bet <= 0) return 'Place a bet first';
        deal();
        return;
      }
      case 'leave': {
        if (!betting) return 'Wait for the round to finish';
        table.players = table.players.filter((q) => q !== p);
        return;
      }
      case 'hit': {
        if (!myTurn) return 'Not your turn';
        p.hand.push(draw());
        const t = total(p.hand);
        if (t > 21) { p.status = 'bust'; advance(); }
        else if (t === 21) { p.status = 'stand'; advance(); }
        else startTurnTimer();
        return;
      }
      case 'stand': {
        if (!myTurn) return 'Not your turn';
        p.status = 'stand';
        advance();
        return;
      }
      case 'double': {
        if (!myTurn) return 'Not your turn';
        if (!table.betting) return 'Betting is off';
        if (p.hand.length !== 2) return 'Can only double on two cards';
        if (p.chips < p.bet) return 'Not enough chips to double';
        p.chips -= p.bet;
        p.bet *= 2;
        p.doubled = true;
        p.hand.push(draw());
        p.status = total(p.hand) > 21 ? 'bust' : 'stand';
        advance();
        return;
      }
      default:
        return 'Unknown action';
    }
  }

  // ---------- state push ----------

  function view(token) {
    const me = table.players.find((p) => p.token === token);
    const playing = table.phase === 'playing';
    const current = table.players[table.turn];
    return {
      you: me ? me.id : null,
      room,
      phase: table.phase,
      betting: table.betting,
      minBet: MIN_BET,
      turn: current ? current.id : null,
      remaining: playing ? Math.max(0, table.deadline - Date.now()) : 0,
      dealer: playing ? [table.dealer[0], { hidden: true }] : table.dealer,
      dealerTotal: playing ? null : total(table.dealer),
      players: table.players.map((p) => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        bet: p.bet,
        lastBet: p.lastBet,
        wins: p.wins,
        losses: p.losses,
        hand: p.hand,
        total: total(p.hand),
        status: p.status,
        result: p.result,
        online: isOnline(p),
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
      if (table.players.length >= MAX_PLAYERS) return 'Table is full';
      table.players.push({
        id: crypto.randomUUID(), token, name,
        chips: START_CHIPS, bet: 0, lastBet: 0, doubled: false, wins: 0, losses: 0,
        hand: [], status: 'out', result: null, offlineSince: Date.now(),
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

  return { connect, join, action, close, connections: () => conns.length };
}

module.exports = { createTwentyOne };
