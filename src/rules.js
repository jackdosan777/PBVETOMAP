/* ===================================================================
   PB REAL-TIME MAP VETO — OFFICIAL RULES (shared by server and client)
   Pure data + pure functions. No I/O, no DOM, no timers.
   The server is the authority; the client imports this only so it can
   render consistent labels and never to decide anything.
   =================================================================== */

'use strict';

/* Official map pool — names are fixed by the tournament and must not change. */
const OFFICIAL_MAPS = [
  { id: 'provence',       name: 'Provence' },
  { id: 'luxville',       name: 'Luxville' },
  { id: 'storm_tube',     name: 'Storm Tube' },
  { id: 'new_midtown',    name: 'New Midtown' },
  { id: 'blow_city',      name: 'Blow City' },
  { id: 'broken_alley',   name: 'Broken Alley' },
  { id: 'secret_mansion', name: 'Secret Mansion' },
  { id: 'roadside',       name: 'Roadside' },
  { id: 'sand_storm',     name: 'Sand Storm' },
  { id: 'airport',        name: 'Airport' }
];

const TURN_SECONDS = 60;   // per ban/pick action
const WARN_AT      = 10;   // first visual warning
const DANGER_AT    = 5;    // stronger warning
const GAMES_IN     = { BO3: 3, BO5: 5 };

/* Confirmed rule: steps 1-6 consume exactly 6 maps in BOTH formats
   (BO3 = 4 bans + 2 picks, BO5 = 4 picks + 2 bans), so a full 10-map
   pool leaves 4 candidates for the referee's random draw. */
const EXPECTED_REMAINING = { BO3: 4, BO5: 4 };
const REQUIRED_POOL_SIZE = 10;

const ERRORS = {
  NOT_YOUR_TURN:     'Not your turn.',
  NO_PERMISSION:     'You do not have permission for this action.',
  MAP_BANNED:        'Map is already banned.',
  MAP_USED:          'Map has already been selected.',
  MAP_DISABLED:      "Map is not in this match's pool.",
  TIMED_OUT:         'Veto has timed out.',
  WAITING_REFEREE:   'Waiting for referee.',
  RANDOM_NOT_READY:  'Random Map is not available yet.',
  ALREADY_SUBMITTED: 'Action already submitted.',
  WRONG_PHASE:       'This action is not available in the current step.',
  NO_SELECTION:      'Select a map first.',
  NOT_ENOUGH_MAPS:   'Not enough maps available to continue.',
  UNKNOWN_ACTION:    'Unknown action.'
};

/* Roles. `team` binds a role to exactly one side; null means no side. */
const ROLES = {
  SUPER_ADMIN:      { label: 'SUPER ADMIN',      admin: true,  referee: true,  team: null },
  TOURNAMENT_ADMIN: { label: 'TOURNAMENT ADMIN', admin: true,  referee: false, team: null },
  REFEREE:          { label: 'REFEREE',          admin: false, referee: true,  team: null },
  CAPTAIN_A:        { label: 'TEAM A CAPTAIN',   admin: false, referee: false, team: 'A' },
  CAPTAIN_B:        { label: 'TEAM B CAPTAIN',   admin: false, referee: false, team: 'B' },
  PUBLIC:           { label: 'PUBLIC VIEWER',    admin: false, referee: false, team: null },
  OBS:              { label: 'OBS / BROADCAST',  admin: false, referee: false, team: null }
};

function roleCanReferee(r) { const x = ROLES[r]; return !!(x && (x.referee || r === 'SUPER_ADMIN')); }
function roleCanAdmin(r)   { const x = ROLES[r]; return !!(x && x.admin); }
function roleActsForTeam(r, team) {
  const x = ROLES[r];
  if (!x) return false;
  if (r === 'SUPER_ADMIN') return true;
  return x.team === team;
}

/* Veto order, generated from the format and the toss-determined first-action team.
   Team A is never assumed to start. */
function buildSequence(format, firstTeam) {
  const F = firstTeam;
  const O = firstTeam === 'A' ? 'B' : 'A';
  if (format === 'BO5') {
    return [
      { n: 1, actor: F,         action: 'PICK',   game: 1 },
      { n: 2, actor: O,         action: 'PICK',   game: 2 },
      { n: 3, actor: O,         action: 'BAN',    game: null },
      { n: 4, actor: F,         action: 'BAN',    game: null },
      { n: 5, actor: F,         action: 'PICK',   game: 3 },
      { n: 6, actor: O,         action: 'PICK',   game: 4 },
      { n: 7, actor: 'REFEREE', action: 'RANDOM', game: 5 }
    ];
  }
  return [
    { n: 1, actor: F,         action: 'BAN',    game: null },
    { n: 2, actor: O,         action: 'BAN',    game: null },
    { n: 3, actor: F,         action: 'PICK',   game: 1 },
    { n: 4, actor: O,         action: 'PICK',   game: 2 },
    { n: 5, actor: O,         action: 'BAN',    game: null },
    { n: 6, actor: F,         action: 'BAN',    game: null },
    { n: 7, actor: 'REFEREE', action: 'RANDOM', game: 3 }
  ];
}

/* ---- pure selectors over a match state (used by both sides) ---- */
function teamName(state, t) {
  if (t === 'REFEREE') return 'REFEREE';
  return t === 'A' ? state.teamA.name : (t === 'B' ? state.teamB.name : 'SYSTEM');
}
function mapById(state, id) {
  return state.mapPool.find(m => m.id === id) || null;
}
function availableMaps(state) {
  return state.mapPool.filter(m => m.status === 'AVAILABLE');
}
function currentStepDef(state) {
  if (!state.sequence || !state.sequence.length || state.currentStep < 1) return null;
  return state.sequence[state.currentStep - 1] || null;
}
function gamesCount(state) { return GAMES_IN[state.format] || 3; }
function isVetoStatus(state) { return typeof state.status === 'string' && state.status.indexOf('VETO_STEP_') === 0; }
function faceLabel(v) { return v === 'HEAD' ? 'HEADS' : (v === 'TAIL' ? 'TAILS' : v); }

module.exports = {
  OFFICIAL_MAPS, TURN_SECONDS, WARN_AT, DANGER_AT, GAMES_IN,
  EXPECTED_REMAINING, REQUIRED_POOL_SIZE, ERRORS, ROLES,
  roleCanReferee, roleCanAdmin, roleActsForTeam, buildSequence,
  teamName, mapById, availableMaps, currentStepDef, gamesCount, isVetoStatus, faceLabel
};
