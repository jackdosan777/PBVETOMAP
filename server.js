/* ===================================================================
   PB REAL-TIME MAP VETO — SERVER
   Express + Socket.IO. The server is the sole authority on match state,
   rule validation and the 60-second clock. Clients send intents only.

   Access model: no accounts. Each match issues one opaque token per role;
   whoever holds a link acts as that role and nothing else.
   =================================================================== */

'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const R = require('./src/rules');
const { createMatch, createEngine } = require('./src/engine');
const store = require('./src/store');

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');

if (!ADMIN_KEY) {
  console.warn('[WARN] ADMIN_KEY is not set — anyone who can reach this server could create matches.');
  console.warn('       Set ADMIN_KEY in the environment before using this in a real tournament.');
}

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });

/* ---------------- live match registry ---------------- */
/* roomId -> { record, engine } ; record = { roomId, tokens, match } */
const live = new Map();

function token() { return crypto.randomBytes(16).toString('hex'); }
function roomCode() { return crypto.randomBytes(4).toString('hex').toUpperCase(); }

function persist(entry) {
  try { store.save(entry.record.roomId, entry.record); }
  catch (e) { console.error('persist failed', e.message); }
}

function loadRoom(roomId) {
  if (live.has(roomId)) return live.get(roomId);
  const record = store.load(roomId);
  if (!record) return null;
  const entry = { record, engine: null };
  entry.engine = createEngine(record.match, (type, payload) => onEngineEvent(entry, type, payload));
  entry.engine.rehydrate();
  live.set(roomId, entry);
  return entry;
}

function onEngineEvent(entry, type, payload) {
  const roomId = entry.record.roomId;
  // state first: an event handler on the client may need the new state to act on
  io.to(roomId).emit('state', publicState(entry));
  if (type !== 'STATE_CHANGED') io.to(roomId).emit('event', { type, payload });
  persist(entry);
}

/* State sent to clients. Tokens never leave the server, and the random draw
   stays hidden until it settles so no client can read the result early. */
function publicState(entry) {
  const m = entry.record.match;
  let out = m;
  if (m.random && m.random.rolling) {
    out = Object.assign({}, m, { random: Object.assign({}, m.random, { result: null }) });
  }
  return { match: out, serverTime: Date.now() };
}

function roleForToken(record, tok) {
  if (!tok) return null;
  const roles = Object.keys(record.tokens);
  for (const role of roles) {
    // timing-safe compare so tokens can't be probed byte by byte
    const a = Buffer.from(record.tokens[role]);
    const b = Buffer.from(String(tok));
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return role;
  }
  return null;
}

function linksFor(record, origin) {
  const base = PUBLIC_URL || origin || '';
  const u = (tok) => `${base}/m/${record.roomId}?t=${tok}`;
  return {
    referee: u(record.tokens.REFEREE),
    teamA:   u(record.tokens.CAPTAIN_A),
    teamB:   u(record.tokens.CAPTAIN_B),
    public:  u(record.tokens.PUBLIC),
    obs:     u(record.tokens.OBS)
  };
}

/* ---------------- admin API ---------------- */
function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return next();                       // dev mode, warned at boot
  const given = req.get('x-admin-key') || req.query.k || '';
  if (given && given === ADMIN_KEY) return next();
  res.status(401).json({ error: 'Invalid admin key.' });
}

app.post('/api/match', requireAdmin, (req, res) => {
  const b = req.body || {};
  const enabled = Array.isArray(b.enabledMapIds) && b.enabledMapIds.length
    ? b.enabledMapIds.filter(id => R.OFFICIAL_MAPS.some(m => m.id === id))
    : R.OFFICIAL_MAPS.map(m => m.id);
  if (enabled.length < 7) return res.status(400).json({ error: 'At least 7 maps are required.' });

  const roomId = roomCode();
  const match = createMatch({
    id: (b.id || 'PB-' + roomId).toString().slice(0, 32),
    format: b.format === 'BO5' ? 'BO5' : 'BO3',
    teamAName: (b.teamAName || 'TEAM A').toString().slice(0, 30),
    teamBName: (b.teamBName || 'TEAM B').toString().slice(0, 30),
    enabledMapIds: enabled
  });
  const record = {
    roomId,
    createdAt: Date.now(),
    tokens: {
      REFEREE: token(), CAPTAIN_A: token(), CAPTAIN_B: token(),
      PUBLIC: token(), OBS: token()
    },
    match
  };
  const entry = { record, engine: null };
  entry.engine = createEngine(match, (t, p) => onEngineEvent(entry, t, p));
  live.set(roomId, entry);
  persist(entry);

  const origin = `${req.protocol}://${req.get('host')}`;
  res.json({ roomId, matchId: match.id, links: linksFor(record, origin) });
});

app.get('/api/matches', requireAdmin, (req, res) => res.json(store.list()));

/* Export the veto log. The referee token or the admin key may fetch it. */
app.get('/api/match/:roomId/log', (req, res) => {
  const entry = loadRoom(req.params.roomId);
  if (!entry) return res.status(404).json({ error: 'Match not found.' });
  const role = roleForToken(entry.record, req.query.t);
  const isAdmin = ADMIN_KEY && (req.get('x-admin-key') === ADMIN_KEY || req.query.k === ADMIN_KEY);
  if (!isAdmin && !(role && R.roleCanReferee(role))) {
    return res.status(403).json({ error: 'Referee token required.' });
  }
  const m = entry.record.match;
  res.setHeader('Content-Disposition', `attachment; filename="${m.id}-veto-log.json"`);
  res.json({
    matchId: m.id, format: m.format, status: m.status,
    teamA: m.teamA, teamB: m.teamB,
    toss1: m.toss1, firstActionTeam: m.firstActionTeam, toss2: m.toss2,
    sequence: m.sequence,
    gameMaps: Object.keys(m.gameMaps).reduce((o, k) => {
      const mp = R.mapById(m, m.gameMaps[k]); o[k] = mp ? mp.name : null; return o;
    }, {}),
    gameSides: m.gameSides,
    gameSidesNote: 'Game 2+ side selection is handled outside this system.',
    warnings: m.warnings,
    mapPool: m.mapPool,
    auditLog: m.auditLog,
    exportedAt: new Date().toISOString()
  });
});

/* The match page itself — the token stays in the query string, read client-side. */
app.get('/m/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'match.html'));
});
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/healthz', (req, res) => res.json({ ok: true, live: live.size }));

/* Test-only: force the current turn's deadline into the past so the server fires
   its own timeout path. Disabled unless ENABLE_TEST_ENDPOINTS is set, so this
   cannot be reached in a normal deployment. */
if (process.env.ENABLE_TEST_ENDPOINTS === '1') {
  app.post('/api/test/expire', (req, res) => {
    if (ADMIN_KEY && req.query.k !== ADMIN_KEY) return res.status(401).json({ error: 'bad key' });
    const entry = loadRoom(String(req.query.room || '').toUpperCase());
    if (!entry) return res.status(404).json({ error: 'not found' });
    const t = entry.record.match.timer;
    if (!t.running) return res.status(409).json({ error: 'timer not running' });
    t.endsAt = Date.now() - 1;
    res.json({ ok: true });
  });
  console.warn('[WARN] test endpoints are ENABLED — do not run with ENABLE_TEST_ENDPOINTS in production.');
}

/* ---------------- realtime ---------------- */
io.on('connection', (socket) => {
  let bound = null;   // { roomId, role }

  socket.on('join', (payload, ack) => {
    const roomId = String((payload && payload.roomId) || '').toUpperCase();
    const entry = loadRoom(roomId);
    if (!entry) return ack && ack({ ok: false, error: 'Match not found.' });
    const role = roleForToken(entry.record, payload && payload.token);
    if (!role) return ack && ack({ ok: false, error: 'Invalid or missing access link.' });

    bound = { roomId, role };
    socket.join(roomId);
    ack && ack({
      ok: true, role,
      roleLabel: R.ROLES[role].label,
      state: publicState(entry)
    });
  });

  socket.on('action', (payload, ack) => {
    if (!bound) return ack && ack({ ok: false, code: 'NO_PERMISSION', message: 'Not joined.' });
    const entry = live.get(bound.roomId) || loadRoom(bound.roomId);
    if (!entry) return ack && ack({ ok: false, code: 'WRONG_PHASE', message: 'Match not found.' });
    const action = Object.assign({}, payload || {});
    action.role = bound.role;                 // role comes from the token, never from the client
    const res = entry.engine.dispatch(action);
    ack && ack(res);
  });

  socket.on('disconnect', () => { bound = null; });
});

server.listen(PORT, () => {
  console.log(`PB Veto server listening on :${PORT}`);
  console.log(`Data dir: ${store.DATA_DIR}`);
  if (PUBLIC_URL) console.log(`Public URL: ${PUBLIC_URL}`);
});

module.exports = { app, server };
