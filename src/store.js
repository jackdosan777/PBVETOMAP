/* ===================================================================
   PERSISTENCE
   JSON files with atomic writes. Zero native dependencies, so it runs on
   any host. The interface below is deliberately small: swapping this for
   Postgres/Redis means reimplementing four functions and nothing else.

   NOTE ON HOSTING: some platforms (Railway/Render free tiers, Fly without
   a volume) use an ephemeral filesystem, so files are lost on redeploy.
   A match only lives for ~an hour so that is usually survivable, but if
   you need the audit log to persist, mount a volume or move to Postgres.
   =================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function fileFor(id) {
  // ids are generated server-side, but never trust one into a path
  const safe = String(id).replace(/[^A-Za-z0-9_-]/g, '');
  return path.join(DATA_DIR, safe + '.json');
}

function save(id, record) {
  ensureDir();
  const target = fileFor(id);
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(record), 'utf8');
  fs.renameSync(tmp, target);          // atomic on POSIX
}

function load(id) {
  try {
    const raw = fs.readFileSync(fileFor(id), 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function list() {
  ensureDir();
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
        return {
          id: r.match.id, roomId: r.roomId, format: r.match.format,
          teamA: r.match.teamA.name, teamB: r.match.teamB.name,
          status: r.match.status, createdAt: r.match.createdAt
        };
      } catch (e) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function remove(id) {
  try { fs.unlinkSync(fileFor(id)); return true; } catch (e) { return false; }
}

module.exports = { save, load, list, remove, DATA_DIR };
