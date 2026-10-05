/* ===================================================================
   SERVER-AUTHORITATIVE VETO ENGINE
   One instance per live match. The server owns the state AND the clock;
   clients only send intents. Nothing here trusts client input.
   =================================================================== */

'use strict';

const R = require('./rules');

function createMatch(cfg) {
  cfg = cfg || {};
  const enabled = cfg.enabledMapIds || R.OFFICIAL_MAPS.map(m => m.id);
  return {
    id: cfg.id || 'PB-MATCH',
    format: cfg.format === 'BO5' ? 'BO5' : 'BO3',
    teamA: { id: 'A', name: cfg.teamAName || 'TEAM A', shortName: (cfg.teamAName || 'TEAM A').slice(0, 14) },
    teamB: { id: 'B', name: cfg.teamBName || 'TEAM B', shortName: (cfg.teamBName || 'TEAM B').slice(0, 14) },
    mapPool: R.OFFICIAL_MAPS.map(m => ({
      id: m.id, name: m.name,
      status: enabled.indexOf(m.id) >= 0 ? 'AVAILABLE' : 'DISABLED',
      assignedGame: null, byTeam: null
    })),
    toss1: { caller: 'A', call: null, result: null, winner: null, choice: null },
    firstActionTeam: null,
    toss2: { caller: null, call: null, result: null, winner: null, side: null, confirmed: false },
    gameMaps: {},
    gameSides: {},
    sequence: [],
    currentStep: 0,
    selection: null,
    random: { candidates: [], rolling: false, result: null, confirmed: false },
    timer: { startedAt: null, endsAt: null, durationMs: R.TURN_SECONDS * 1000, running: false },
    status: 'TOSS_1',
    timeout: null,
    warnings: { A: 0, B: 0 },
    auditLog: [],
    createdAt: Date.now(),
    completedAt: null,
    seq: 0
  };
}

/* An engine wraps one match state and emits events the server broadcasts. */
function createEngine(state, onEvent) {
  const emit = (type, payload) => { if (onEvent) onEvent(type, payload || {}); };
  const now = () => Date.now();

  let timerHandle = null;
  let warned = {};

  const S = () => state;
  const tName = t => R.teamName(state, t);
  const mapById = id => R.mapById(state, id);
  const available = () => R.availableMaps(state);
  const stepDef = () => R.currentStepDef(state);
  const isVeto = () => R.isVetoStatus(state);

  function ok(extra) { return Object.assign({ ok: true }, extra || {}); }
  function err(code) { return { ok: false, code, message: R.ERRORS[code] || code }; }

  /* -------- append-only audit log -------- */
  function audit(rec) {
    state.seq += 1;
    state.auditLog.push({
      seq: state.seq,
      matchId: state.id,
      step: rec.step != null ? rec.step : null,
      team: rec.team || null,
      teamName: rec.team ? tName(rec.team) : null,
      role: rec.role || 'SYSTEM',
      action: rec.action,
      map: rec.map || null,
      timestamp: now(),
      timerStart: rec.timerStart != null ? rec.timerStart : null,
      timerEnd: rec.timerEnd != null ? rec.timerEnd : null,
      result: rec.result || null,
      status: rec.status || 'COMPLETED'
    });
  }

  /* -------- server-side timer: the single source of truth -------- */
  function startTimer() {
    const t = state.timer;
    t.startedAt = now();
    t.endsAt = t.startedAt + R.TURN_SECONDS * 1000;
    t.durationMs = R.TURN_SECONDS * 1000;
    t.running = true;
    warned = {};
    emit('TIMER_STARTED', { step: state.currentStep, endsAt: t.endsAt });
    ensureTicking();
  }
  function stopTimer() { state.timer.running = false; }
  function ensureTicking() {
    if (timerHandle) return;
    timerHandle = setInterval(onTick, 250);
    if (timerHandle.unref) timerHandle.unref();
  }
  function onTick() {
    const t = state.timer;
    if (!t.running) return;
    const remain = Math.max(0, t.endsAt - now());
    const secs = Math.ceil(remain / 1000);
    if (secs <= R.WARN_AT && !warned.w10) { warned.w10 = true; emit('TIMER_WARNING', { at: R.WARN_AT }); }
    if (secs <= R.DANGER_AT && !warned.w5) { warned.w5 = true; emit('TIMER_WARNING', { at: R.DANGER_AT }); }
    if (remain <= 0) handleTimeout();
  }

  /* On 00:00: lock, record TIMEOUT, issue a warning, wait for the referee.
     No map is selected, banned, picked or forfeited. */
  function handleTimeout() {
    const step = stepDef();
    if (!step || !isVeto()) { stopTimer(); return; }
    const t = state.timer;
    stopTimer();
    state.selection = null;
    state.warnings[step.actor] = (state.warnings[step.actor] || 0) + 1;
    const warnNo = state.warnings[step.actor];
    state.timeout = {
      step: state.currentStep, team: step.actor, action: step.action,
      warningNo: warnNo, startedAt: t.startedAt, endedAt: now()
    };
    state.status = 'TIMEOUT_WAITING_REFEREE';
    audit({
      step: state.currentStep, team: step.actor, role: 'SYSTEM', action: step.action,
      map: null, timerStart: t.startedAt, timerEnd: now(),
      result: 'TIMEOUT — WARNING #' + warnNo, status: 'TIMEOUT'
    });
    emit('TIMEOUT', { step: state.currentStep, team: step.actor, warningNo: warnNo });
    emit('STATE_CHANGED', {});
  }

  /* -------- phase transitions -------- */
  function beginStep(n) {
    state.currentStep = n;
    state.selection = null;
    const step = state.sequence[n - 1];
    if (!step) return;
    if (step.action === 'RANDOM') {
      state.status = 'RANDOM_MAP';
      state.timer.running = false;
      state.random = { candidates: available().map(m => m.id), rolling: false, result: null, confirmed: false };
      emit('TURN_STARTED', { step: n, actor: 'REFEREE', action: 'RANDOM' });
      return;
    }
    state.status = 'VETO_STEP_' + n;
    emit('TURN_STARTED', { step: n, actor: step.actor, action: step.action });
    startTimer();
  }
  function advance() {
    if (state.currentStep >= state.sequence.length) return;
    beginStep(state.currentStep + 1);
  }
  function startSideToss() {
    state.toss2.caller = state.firstActionTeam;
    state.status = 'SIDE_TOSS';
    state.timer.running = false;
    emit('SIDE_TOSS_STARTED', { caller: state.toss2.caller });
  }
  function completeMatch() {
    state.status = 'COMPLETED';
    state.completedAt = now();
    state.timer.running = false;
    stopTimer();
    audit({ action: 'MATCH_COMPLETED', result: 'COMPLETED' });
    emit('MATCH_COMPLETED', {});
  }

  /* -------- action handlers -------- */
  const handlers = {

    TOSS1_CALL(a) {
      if (state.status !== 'TOSS_1') return err('WRONG_PHASE');
      if (state.toss1.call) return err('ALREADY_SUBMITTED');
      if (!R.roleActsForTeam(a.role, state.toss1.caller)) return err('NOT_YOUR_TURN');
      if (a.call !== 'HEAD' && a.call !== 'TAIL') return err('NO_SELECTION');
      state.toss1.call = a.call;
      audit({ team: state.toss1.caller, role: a.role, action: 'TOSS1_CALL', result: a.call });
      return ok();
    },

    TOSS1_FLIP(a) {
      if (state.status !== 'TOSS_1') return err('WRONG_PHASE');
      if (!state.toss1.call) return err('NO_SELECTION');
      if (state.toss1.result) return err('ALREADY_SUBMITTED');
      if (!R.roleCanReferee(a.role)) return err('NO_PERMISSION');
      const isHead = Math.random() < 0.5;          // server-side randomness only
      state.toss1.result = isHead ? 'HEAD' : 'TAIL';
      state.toss1.winner = state.toss1.result === state.toss1.call
        ? state.toss1.caller
        : (state.toss1.caller === 'A' ? 'B' : 'A');
      state.status = 'TOSS_1_CHOICE';
      audit({ team: state.toss1.winner, role: a.role, action: 'TOSS1_RESULT',
              result: state.toss1.result + ' — WINNER ' + tName(state.toss1.winner) });
      emit('TOSS_COMPLETED', { toss: 1, result: state.toss1.result, winner: state.toss1.winner });
      return ok();
    },

    TOSS1_CHOICE(a) {
      if (state.status !== 'TOSS_1_CHOICE') return err('WRONG_PHASE');
      if (state.toss1.choice) return err('ALREADY_SUBMITTED');
      if (!R.roleActsForTeam(a.role, state.toss1.winner)) return err('NOT_YOUR_TURN');
      if (a.choice !== 'FIRST' && a.choice !== 'SECOND') return err('NO_SELECTION');
      state.toss1.choice = a.choice;
      state.firstActionTeam = a.choice === 'FIRST'
        ? state.toss1.winner
        : (state.toss1.winner === 'A' ? 'B' : 'A');
      state.sequence = R.buildSequence(state.format, state.firstActionTeam);
      audit({ team: state.toss1.winner, role: a.role, action: 'TOSS1_CHOICE',
              result: a.choice + ' — FIRST ACTION: ' + tName(state.firstActionTeam) });
      beginStep(1);
      return ok();
    },

    SELECT_MAP(a) {
      if (state.status === 'TIMEOUT_WAITING_REFEREE') return err('WAITING_REFEREE');
      if (!isVeto()) return err('WRONG_PHASE');
      const step = stepDef();
      if (!step) return err('WRONG_PHASE');
      if (!R.roleActsForTeam(a.role, step.actor)) return err('NOT_YOUR_TURN');
      const m = mapById(a.mapId);
      if (!m || m.status === 'DISABLED') return err('MAP_DISABLED');
      if (m.status === 'BANNED') return err('MAP_BANNED');
      if (m.status !== 'AVAILABLE') return err('MAP_USED');
      state.selection = a.mapId;
      emit('MAP_SELECTED', { step: state.currentStep, team: step.actor, mapId: a.mapId });
      return ok();
    },

    CONFIRM_ACTION(a) {
      if (state.status === 'TIMEOUT_WAITING_REFEREE') return err('WAITING_REFEREE');
      if (!isVeto()) return err('WRONG_PHASE');
      const step = stepDef();
      if (!step) return err('WRONG_PHASE');
      if (!R.roleActsForTeam(a.role, step.actor)) return err('NOT_YOUR_TURN');
      const mapId = a.mapId || state.selection;
      if (!mapId) return err('NO_SELECTION');
      const m = mapById(mapId);
      if (!m || m.status === 'DISABLED') return err('MAP_DISABLED');
      if (m.status === 'BANNED') return err('MAP_BANNED');
      if (m.status !== 'AVAILABLE') return err('MAP_USED');

      const tStart = state.timer.startedAt;
      if (step.action === 'BAN') {
        m.status = 'BANNED'; m.byTeam = step.actor;
        emit('MAP_BANNED', { step: state.currentStep, team: step.actor, mapId });
      } else {
        m.status = 'PICKED'; m.byTeam = step.actor; m.assignedGame = step.game;
        state.gameMaps[step.game] = mapId;
        emit('MAP_PICKED', { step: state.currentStep, team: step.actor, mapId, game: step.game });
      }
      audit({ step: state.currentStep, team: step.actor, role: a.role, action: step.action,
              map: m.name, timerStart: tStart, timerEnd: now(),
              result: step.game ? ('GAME ' + step.game) : null });
      state.selection = null;
      stopTimer();
      advance();
      return ok();
    },

    REFEREE_CONFIRM_WARNING(a) {
      if (state.status !== 'TIMEOUT_WAITING_REFEREE') return err('WRONG_PHASE');
      if (!R.roleCanReferee(a.role)) return err('NO_PERMISSION');
      const ctx = state.timeout;
      audit({ step: ctx.step, team: ctx.team, role: a.role, action: 'REFEREE_ACTION',
              result: 'WARNING #' + ctx.warningNo + ' CONFIRMED — VETO CONTINUES',
              status: 'REFEREE_INTERVENTION' });
      emit('REFEREE_ACTION', { kind: 'CONFIRM_WARNING', step: ctx.step, warningNo: ctx.warningNo });
      state.timeout = null;
      beginStep(ctx.step);
      return ok();
    },

    RANDOM_START(a) {
      if (state.status !== 'RANDOM_MAP') return err('RANDOM_NOT_READY');
      if (!R.roleCanReferee(a.role)) return err('NO_PERMISSION');
      if (state.random.rolling || state.random.result) return err('ALREADY_SUBMITTED');
      const cands = available();
      if (!cands.length) return err('NOT_ENOUGH_MAPS');
      state.random.candidates = cands.map(m => m.id);
      state.random.rolling = true;
      state.random.result = cands[Math.floor(Math.random() * cands.length)].id;
      audit({ step: state.currentStep, role: a.role, action: 'RANDOM_START',
              result: cands.length + ' CANDIDATES', status: 'IN_PROGRESS' });
      emit('RANDOM_MAP_STARTED', { candidates: state.random.candidates });
      return ok();
    },

    RANDOM_SETTLE() {
      if (state.status !== 'RANDOM_MAP') return err('WRONG_PHASE');
      state.random.rolling = false;
      return ok();
    },

    RANDOM_CONFIRM(a) {
      if (state.status !== 'RANDOM_MAP') return err('RANDOM_NOT_READY');
      if (!R.roleCanReferee(a.role)) return err('NO_PERMISSION');
      if (!state.random.result) return err('RANDOM_NOT_READY');
      if (state.random.confirmed) return err('ALREADY_SUBMITTED');
      const step = stepDef();
      const m = mapById(state.random.result);
      m.status = 'RANDOM'; m.assignedGame = step.game; m.byTeam = 'REFEREE';
      state.gameMaps[step.game] = m.id;
      state.random.confirmed = true;
      audit({ step: state.currentStep, team: 'REFEREE', role: a.role, action: 'RANDOM',
              map: m.name, result: 'GAME ' + step.game + ' — RESULT LOCKED' });
      emit('RANDOM_MAP_COMPLETED', { mapId: m.id, game: step.game });
      startSideToss();
      return ok();
    },

    TOSS2_CALL(a) {
      if (state.status !== 'SIDE_TOSS') return err('WRONG_PHASE');
      if (state.toss2.call) return err('ALREADY_SUBMITTED');
      if (!R.roleActsForTeam(a.role, state.toss2.caller)) return err('NOT_YOUR_TURN');
      if (a.call !== 'HEAD' && a.call !== 'TAIL') return err('NO_SELECTION');
      state.toss2.call = a.call;
      audit({ team: state.toss2.caller, role: a.role, action: 'TOSS2_CALL', result: a.call });
      return ok();
    },

    TOSS2_FLIP(a) {
      if (state.status !== 'SIDE_TOSS') return err('WRONG_PHASE');
      if (!state.toss2.call) return err('NO_SELECTION');
      if (state.toss2.result) return err('ALREADY_SUBMITTED');
      if (!R.roleCanReferee(a.role)) return err('NO_PERMISSION');
      const isHead = Math.random() < 0.5;
      state.toss2.result = isHead ? 'HEAD' : 'TAIL';
      state.toss2.winner = state.toss2.result === state.toss2.call
        ? state.toss2.caller
        : (state.toss2.caller === 'A' ? 'B' : 'A');
      state.status = 'SIDE_SELECTION';
      audit({ team: state.toss2.winner, role: a.role, action: 'TOSS2_RESULT',
              result: state.toss2.result + ' — WINNER ' + tName(state.toss2.winner) });
      emit('TOSS_COMPLETED', { toss: 2, result: state.toss2.result, winner: state.toss2.winner });
      return ok();
    },

    SELECT_SIDE(a) {
      if (state.status !== 'SIDE_SELECTION') return err('WRONG_PHASE');
      if (state.toss2.side) return err('ALREADY_SUBMITTED');
      if (!R.roleActsForTeam(a.role, state.toss2.winner)) return err('NOT_YOUR_TURN');
      if (a.side !== 'RED' && a.side !== 'BLUE') return err('NO_SELECTION');
      const w = state.toss2.winner, l = w === 'A' ? 'B' : 'A';
      const other = a.side === 'RED' ? 'BLUE' : 'RED';
      state.toss2.side = a.side;
      state.gameSides[1] = {};
      state.gameSides[1][w] = a.side;
      state.gameSides[1][l] = other;
      audit({ team: w, role: a.role, action: 'SIDE_SELECTED',
              result: 'GAME 1 — ' + tName(w) + ': ' + a.side + ' / ' + tName(l) + ': ' + other,
              status: 'PENDING_CONFIRMATION' });
      emit('SIDE_SELECTED', { game: 1, winner: w, side: a.side });
      state.status = 'SIDE_CONFIRMATION';
      return ok();
    },

    CONFIRM_SIDE_LOCK(a) {
      if (state.status !== 'SIDE_CONFIRMATION') return err('WRONG_PHASE');
      if (!R.roleCanReferee(a.role)) return err('NO_PERMISSION');
      if (state.toss2.confirmed) return err('ALREADY_SUBMITTED');
      state.toss2.confirmed = true;
      const g = state.gameSides[1];
      audit({ role: a.role, action: 'SIDE_LOCKED',
              result: 'GAME 1 SIDE SELECTION CONFIRMED — ' + tName('A') + ': ' + g.A + ' / ' + tName('B') + ': ' + g.B,
              status: 'CONFIRMED' });
      emit('SIDE_LOCKED', { game: 1, sides: g });
      completeMatch();
      return ok();
    }
  };

  function dispatch(action) {
    const h = handlers[action.type];
    if (!h) return err('UNKNOWN_ACTION');
    let res;
    try { res = h(action) || ok(); }
    catch (e) { res = { ok: false, code: 'ENGINE_ERROR', message: String((e && e.message) || e) }; }
    if (res.ok) emit('STATE_CHANGED', {});
    return res;
  }

  /* Resume a match loaded from storage: restart the ticker if a turn was live. */
  function rehydrate() {
    if (state.timer.running) {
      if (state.timer.endsAt <= now()) handleTimeout();
      else ensureTicking();
    }
  }

  function dispose() {
    if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
  }

  return { dispatch, getState: S, rehydrate, dispose, startTimer, ensureTicking };
}

module.exports = { createMatch, createEngine };
