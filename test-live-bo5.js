const { chromium } = require('playwright');
const BASE='http://localhost:3100', KEY='testkey';
let pass=0,fail=0; const fails=[];
const ok=(l,c,d)=>{c?pass++:(fail++,fails.push(l+(d?'  -> '+d:'')))};
const eq=(l,a,e)=>ok(l,JSON.stringify(a)===JSON.stringify(e),'got '+JSON.stringify(a)+' want '+JSON.stringify(e));
const wait=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  const r = await (await fetch(BASE+'/api/match',{method:'POST',
    headers:{'content-type':'application/json','x-admin-key':KEY},
    body:JSON.stringify({id:'PB-LIVE-BO5',format:'BO5',teamAName:'Alpha',teamBName:'Bravo'})})).json();
  const br = await chromium.launch();
  const open = async url => { const c=await br.newContext(); const p=await c.newPage();
    const errs=[]; p.on('pageerror',e=>errs.push(e.message)); await p.goto(url);
    await p.waitForFunction(()=>!!document.getElementById('app').innerHTML,{timeout:8000}); return {p,errs}; };
  const ref=await open(r.links.referee), A=await open(r.links.teamA), B=await open(r.links.teamB);
  await wait(800);
  const st = p => p.evaluate(()=>({status:window.__pbstate.status, step:window.__pbstate.currentStep,
    avail:window.__pbstate.mapPool.filter(m=>m.status==='AVAILABLE').length,
    games:Object.keys(window.__pbstate.gameMaps).length, first:window.__pbstate.firstActionTeam,
    seq:window.__pbstate.sequence.map(s=>s.actor+':'+s.action)}));

  await A.p.click('[data-act="toss1Call"][data-call="TAIL"]');
  await wait(300); await ref.p.click('[data-act="toss1Flip"]'); await wait(2600);
  const winner = await ref.p.evaluate(()=>window.__pbstate.toss1.winner);
  await (winner==='A'?A.p:B.p).click('[data-act="toss1Choice"][data-choice="SECOND"]');
  await wait(600);
  const s1 = await st(ref.p);
  eq('BO5 first action is the team that did NOT win the toss', s1.first, winner==='A'?'B':'A');
  eq('BO5 sequence shape', s1.seq, [s1.first+':PICK', (s1.first==='A'?'B':'A')+':PICK',
      (s1.first==='A'?'B':'A')+':BAN', s1.first+':BAN', s1.first+':PICK',
      (s1.first==='A'?'B':'A')+':PICK', 'REFEREE:RANDOM']);

  for(let i=0;i<6;i++){
    const cur = await ref.p.evaluate(()=>{const s=window.__pbstate; return s.sequence[s.currentStep-1];});
    const page = cur.actor==='A'?A.p:B.p;
    await page.click('.map-card.selectable'); await wait(220);
    await page.click('[data-act="confirmAction"]'); await wait(450);
  }
  const s2 = await st(ref.p);
  eq('BO5 reaches random with 4 candidates', s2.avail, 4);
  eq('BO5 four games picked before the draw', s2.games, 4);
  eq('BO5 status', s2.status, 'RANDOM_MAP');

  await ref.p.click('[data-act="randomStart"]'); await wait(5200);
  await ref.p.click('[data-act="randomConfirm"]'); await wait(700);
  const s3 = await st(ref.p);
  eq('BO5 five games assigned', s3.games, 5);
  eq('BO5 moves to side toss', s3.status, 'SIDE_TOSS');

  const caller = await ref.p.evaluate(()=>window.__pbstate.toss2.caller);
  await (caller==='A'?A.p:B.p).click('[data-act="toss2Call"][data-call="HEAD"]');
  await wait(350); await ref.p.click('[data-act="toss2Flip"]'); await wait(2600);
  const w2 = await ref.p.evaluate(()=>window.__pbstate.toss2.winner);
  await (w2==='A'?A.p:B.p).click('[data-act="selectSide"][data-side="BLUE"]'); await wait(600);
  eq('BO5 awaits referee lock', (await st(ref.p)).status, 'SIDE_CONFIRMATION');
  await ref.p.click('[data-act="confirmSideLock"]'); await wait(700);
  eq('BO5 completed', (await st(ref.p)).status, 'COMPLETED');
  eq('BO5 team B client agrees', (await st(B.p)).status, 'COMPLETED');

  const log = await (await fetch(`${BASE}/api/match/${r.roomId}/log?t=${new URL(r.links.referee).searchParams.get('t')}`)).json();
  eq('BO5 log has 5 game maps', Object.keys(log.gameMaps).length, 5);
  eq('BO5 log sides only for game 1', Object.keys(log.gameSides), ['1']);
  ok('no page errors', [...ref.errs,...A.errs,...B.errs].length===0, [...ref.errs,...A.errs,...B.errs].join('|'));

  console.log('PASS: '+pass+'   FAIL: '+fail);
  if(fails.length) fails.forEach(f=>console.log('  x '+f));
  await br.close(); process.exit(fail?1:0);
})().catch(e=>{console.error('FATAL',e);process.exit(1)});
