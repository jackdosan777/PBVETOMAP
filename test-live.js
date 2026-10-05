/* Multi-client integration test: three independent browser contexts
   (referee, Team A captain, Team B captain) against the real server. */
const { chromium } = require('playwright');

const BASE = 'http://localhost:3100';
const KEY = 'testkey';
let pass = 0, fail = 0; const fails = [];
const ok = (l, c, d) => { c ? pass++ : (fail++, fails.push(l + (d ? '  -> ' + d : ''))); };
const eq = (l, a, e) => ok(l, JSON.stringify(a) === JSON.stringify(e), 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(e));
const wait = ms => new Promise(r => setTimeout(r, ms));

async function createMatch(format) {
  const res = await fetch(BASE + '/api/match', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-key': KEY },
    body: JSON.stringify({ id: 'PB-LIVE-' + format, format, teamAName: 'Death Race TH', teamBName: 'PBOC Champion' })
  });
  return res.json();
}

// read a client's current view of the match
const snap = p => p.evaluate(() => {
  const w = window.__pb || {};
  return w.state ? {
    status: w.state.status, step: w.state.currentStep,
    first: w.state.firstActionTeam,
    avail: w.state.mapPool.filter(m => m.status === 'AVAILABLE').length,
    games: Object.keys(w.state.gameMaps).length,
    warnings: w.state.warnings,
    role: w.role, connected: w.connected,
    timerRunning: w.state.timer.running,
    remaining: w.remaining()
  } : null;
});

async function openAs(browser, url) {
  const ctx = await browser.newContext();          // separate context = separate "device"
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  await p.goto(url);
  await p.waitForFunction(() => !!document.getElementById('app').innerHTML, { timeout: 8000 });
  // expose internals for assertions only
  await p.evaluate(() => {
    window.__pb = {
      get state(){ return window.__pbstate; },
      get role(){ return window.__pbrole; },
      get connected(){ return window.__pbconn; },
      remaining(){ return window.__pbremaining ? window.__pbremaining() : 0; }
    };
  });
  return { page: p, ctx, errs };
}

async function run() {
  const browser = await chromium.launch();
  console.log('=== BO3 live multi-client ===');
  const m = await createMatch('BO3');

  const ref = await openAs(browser, m.links.referee);
  const capA = await openAs(browser, m.links.teamA);
  const capB = await openAs(browser, m.links.teamB);
  const pub = await openAs(browser, m.links.public);
  await wait(900);

  // roles are assigned by token, not chosen by the client
  const roleOf = p => p.evaluate(() => document.querySelector('#statusHost .chip') ? document.querySelector('#statusHost .chip').textContent : null);
  eq('referee link yields referee view', await roleOf(ref.page), 'REFEREE');
  eq('team A link shows team A name', await roleOf(capA.page), 'Death Race TH');
  eq('team B link shows team B name', await roleOf(capB.page), 'PBOC Champion');
  eq('public link is a public viewer', await roleOf(pub.page), 'PUBLIC VIEWER');

  const txt = p => p.evaluate(() => document.getElementById('app').textContent);
  ok('all clients see the same teams',
     (await txt(capA.page)).includes('PBOC Champion') && (await txt(pub.page)).includes('Death Race TH'));

  // a bad token must be refused
  const bad = await openAs(browser, BASE + '/m/' + m.roomId + '?t=deadbeef');
  await wait(600);
  ok('invalid token is rejected', (await txt(bad.page)).indexOf('Cannot open this match') >= 0);

  // --- Toss #1: only Team A may call; the button only exists on A's screen
  const hasCall = p => p.evaluate(() => !!document.querySelector('[data-act="toss1Call"]'));
  ok('team B has no toss call control', !(await hasCall(capB.page)));
  ok('team A can call the toss', await hasCall(capA.page));

  // Team B tries to call anyway, straight over the socket — server must refuse
  const forced = await capB.page.evaluate(() => new Promise(res => {
    window.__sock.emit('action', { type: 'TOSS1_CALL', call: 'HEAD', role: 'CAPTAIN_A' }, res);
  }));
  eq('forged role in payload is ignored by the server', forced.code, 'NOT_YOUR_TURN');

  await capA.page.click('[data-act="toss1Call"][data-call="HEAD"]');
  await wait(400);
  // referee flips
  await ref.page.click('[data-act="toss1Flip"]');
  await wait(2600);
  const afterFlip = await snap(ref.page);
  eq('status after flip', afterFlip.status, 'TOSS_1_CHOICE');
  const sA = await snap(capA.page), sB = await snap(capB.page), sP = await snap(pub.page);
  eq('team A sees the same status', sA.status, 'TOSS_1_CHOICE');
  eq('team B sees the same status', sB.status, 'TOSS_1_CHOICE');
  eq('public sees the same status', sP.status, 'TOSS_1_CHOICE');

  // winner chooses order
  const winner = await ref.page.evaluate(() => window.__pbstate.toss1.winner);
  const winPage = winner === 'A' ? capA.page : capB.page;
  await winPage.click('[data-act="toss1Choice"][data-choice="FIRST"]');
  await wait(500);
  const s1 = await snap(ref.page);
  eq('first action team equals toss winner', s1.first, winner);
  eq('veto started', s1.status, 'VETO_STEP_1');
  ok('timer running', s1.timerRunning);

  // --- every client shows the same countdown (within a small tolerance)
  const rRef = (await snap(ref.page)).remaining;
  const rA = (await snap(capA.page)).remaining;
  const rPub = (await snap(pub.page)).remaining;
  ok('timers agree across devices (<1.5s apart)',
     Math.abs(rRef - rA) < 1500 && Math.abs(rRef - rPub) < 1500,
     `ref=${rRef} a=${rA} pub=${rPub}`);
  ok('timer is ~60s', rRef > 55000 && rRef <= 60000, String(rRef));

  // --- only the acting captain can click maps
  const actor = (await ref.page.evaluate(() => window.__pbstate.sequence[0].actor));
  const actPage = actor === 'A' ? capA.page : capB.page;
  const idlePage = actor === 'A' ? capB.page : capA.page;
  ok('acting captain has selectable maps', await actPage.evaluate(() => !!document.querySelector('.map-card.selectable')));
  ok('idle captain has no selectable maps', await idlePage.evaluate(() => !document.querySelector('.map-card.selectable')));
  ok('public viewer has no selectable maps', await pub.page.evaluate(() => !document.querySelector('.map-card.selectable')));

  // idle captain forces a ban over the socket -> refused
  const forced2 = await idlePage.evaluate(() => new Promise(res => {
    const id = window.__pbstate.mapPool.find(m => m.status === 'AVAILABLE').id;
    window.__sock.emit('action', { type: 'CONFIRM_ACTION', mapId: id }, res);
  }));
  eq('out-of-turn ban refused by server', forced2.code, 'NOT_YOUR_TURN');

  // proper ban
  await actPage.click('.map-card.selectable');
  await wait(300);
  await actPage.click('[data-act="confirmAction"]');
  await wait(600);
  const s2 = await snap(ref.page);
  eq('step advanced on every client', s2.step, 2);
  eq('one map consumed', s2.avail, 9);
  eq('opponent client saw it too', (await snap(idlePage)).avail, 9);
  eq('public client saw it too', (await snap(pub.page)).avail, 9);

  // --- timeout: server-driven. Force the deadline forward on the server.
  await fetch(BASE + '/api/test/expire?room=' + m.roomId + '&k=' + KEY, { method: 'POST' });
  await wait(1400);
  const s3 = await snap(ref.page);
  eq('timeout reached on the server', s3.status, 'TIMEOUT_WAITING_REFEREE');
  ok('warning issued to the team on the clock', (s3.warnings.A + s3.warnings.B) === 1, JSON.stringify(s3.warnings));
  eq('no map was auto-consumed', s3.avail, 9);
  eq('captains see the timeout too', (await snap(capA.page)).status, 'TIMEOUT_WAITING_REFEREE');
  ok('captain has no confirm-warning button',
     await capA.page.evaluate(() => !document.querySelector('[data-act="refConfirmWarning"]')));
  ok('referee has the confirm-warning button',
     await ref.page.evaluate(() => !!document.querySelector('[data-act="refConfirmWarning"]')));

  await ref.page.click('[data-act="refConfirmWarning"]');
  await wait(600);
  const s4 = await snap(ref.page);
  eq('same step resumed', s4.step, 2);
  ok('fresh timer after confirmation', s4.remaining > 55000, String(s4.remaining));

  // --- reconnect: reload a captain mid-match, state must come back intact
  await capA.page.reload();
  await capA.page.waitForFunction(() => !!document.getElementById('app').innerHTML, { timeout: 8000 });
  await capA.page.evaluate(() => {
    window.__pb = { get state(){ return window.__pbstate; }, get role(){ return window.__pbrole; },
                    get connected(){ return window.__pbconn; }, remaining(){ return window.__pbremaining(); } };
  });
  await wait(900);
  const s5 = await snap(capA.page);
  eq('reconnected client recovers the step', s5.step, 2);
  eq('reconnected client recovers the pool', s5.avail, 9);
  eq('reconnected client keeps its role', s5.role, 'CAPTAIN_A');

  // --- finish the veto through the UI
  for (let i = 0; i < 5; i++) {
    const st = await ref.page.evaluate(() => {
      const s = window.__pbstate; return s.sequence[s.currentStep - 1];
    });
    if (!st || st.action === 'RANDOM') break;
    const page = st.actor === 'A' ? capA.page : capB.page;
    await page.click('.map-card.selectable');
    await wait(250);
    await page.click('[data-act="confirmAction"]');
    await wait(500);
  }
  const s6 = await snap(ref.page);
  eq('reached the random step', s6.status, 'RANDOM_MAP');
  eq('exactly 4 candidates remain', s6.avail, 4);

  ok('captain cannot randomize', await capA.page.evaluate(() => !document.querySelector('[data-act="randomStart"]')));
  await ref.page.click('[data-act="randomStart"]');
  await wait(5200);
  await ref.page.click('[data-act="randomConfirm"]');
  await wait(700);
  const s7 = await snap(ref.page);
  eq('all three games assigned', s7.games, 3);
  eq('moved to side toss', s7.status, 'SIDE_TOSS');

  // --- toss #2 + side + referee lock
  const caller = await ref.page.evaluate(() => window.__pbstate.toss2.caller);
  const callerPage = caller === 'A' ? capA.page : capB.page;
  eq('toss2 caller is the first-action team', caller, s1.first);
  await callerPage.click('[data-act="toss2Call"][data-call="HEAD"]');
  await wait(400);
  await ref.page.click('[data-act="toss2Flip"]');
  await wait(2600);
  const w2 = await ref.page.evaluate(() => window.__pbstate.toss2.winner);
  const w2page = w2 === 'A' ? capA.page : capB.page;
  await w2page.click('[data-act="selectSide"][data-side="RED"]');
  await wait(600);
  const s8 = await snap(ref.page);
  eq('awaiting referee lock', s8.status, 'SIDE_CONFIRMATION');
  ok('captain cannot lock', await capA.page.evaluate(() => !document.querySelector('[data-act="confirmSideLock"]')));
  await ref.page.click('[data-act="confirmSideLock"]');
  await wait(700);
  const s9 = await snap(ref.page);
  eq('match completed', s9.status, 'COMPLETED');
  eq('public client sees completion', (await snap(pub.page)).status, 'COMPLETED');

  // --- server-side log export is referee-gated
  const logRef = await fetch(`${BASE}/api/match/${m.roomId}/log?t=${new URL(m.links.referee).searchParams.get('t')}`);
  const logPub = await fetch(`${BASE}/api/match/${m.roomId}/log?t=${new URL(m.links.public).searchParams.get('t')}`);
  eq('referee can export the log', logRef.status, 200);
  eq('public cannot export the log', logPub.status, 403);
  const logJson = await logRef.json();
  eq('log has 3 game maps', Object.keys(logJson.gameMaps).length, 3);
  ok('log carries the audit trail', logJson.auditLog.length > 10, String(logJson.auditLog.length));
  eq('log has sides only for game 1', Object.keys(logJson.gameSides), ['1']);
  ok('log records the timeout warning', logJson.auditLog.some(a => a.status === 'TIMEOUT'));

  const allErrs = [...ref.errs, ...capA.errs, ...capB.errs, ...pub.errs];
  ok('no page errors on any client', allErrs.length === 0, allErrs.join(' | '));

  console.log('\n──────────────');
  console.log('PASS: ' + pass + '   FAIL: ' + fail);
  if (fails.length) { console.log('FAILURES:'); fails.forEach(f => console.log('  x ' + f)); }
  await browser.close();
  process.exit(fail ? 1 : 0);
}

run().catch(e => { console.error('FATAL', e); process.exit(1); });
