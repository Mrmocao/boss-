import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MonitorStore } from '../src/monitor-store.mjs';

async function temp() { return mkdtemp(join(tmpdir(), 'boss-monitor-')); }

test('persists state and reloads it after restart', async t => {
  const root = await temp(); t.after(() => rm(root, {recursive:true,force:true}));
  const a = await new MonitorStore(root).init();
  assert.equal(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')).schemaVersion, 1);
  await a.transaction(s => { s.account={profile:'company-2'}; s.conversations.c1={status:'waiting_reply'}; s.events.push({type:'seen'}); });
  await a.close();
  const b = await new MonitorStore(root).init();
  assert.equal(b.snapshot().conversations.c1.status, 'waiting_reply');
  assert.equal(b.snapshot().account.profile, 'company-2');
  await b.close();
});

test('serializes transactions and failed transaction is not committed', async t => {
  const root=await temp(); t.after(()=>rm(root,{recursive:true,force:true})); const s=await new MonitorStore(root).init();
  await Promise.all(Array.from({length:20},(_,i)=>s.transaction(async state=>{state.runtime.count=(state.runtime.count||0)+1;state.events.push({i}); await Promise.resolve();})));
  assert.equal(s.snapshot().runtime.count,20);
  await assert.rejects(s.transaction(state=>{state.runtime.count=999;throw Error('abort')}));
  assert.equal(s.snapshot().runtime.count,20); await s.close();
});

test('second live store is rejected and stale dead lock is reclaimed', async t => {
  const root=await temp(); t.after(()=>rm(root,{recursive:true,force:true})); const a=await new MonitorStore(root).init();
  await assert.rejects(new MonitorStore(root).init(), {code:'LOCK_HELD'}); await a.close();
  await mkdir(join(root,'daemon.lock')); await writeFile(join(root,'daemon.lock','owner.json'),JSON.stringify({pid:99999999,token:'old'}));
  const b=await new MonitorStore(root).init(); assert.equal(b.snapshot().schemaVersion,1); await b.close();
});

test('malformed durable state and malformed lock fail closed', async t => {
  const root=await temp(); t.after(()=>rm(root,{recursive:true,force:true})); await writeFile(join(root,'state.json'),'{bad');
  await assert.rejects(new MonitorStore(root).init(), {code:'STATE_CORRUPT'});
  const root2=await temp(); t.after(()=>rm(root2,{recursive:true,force:true})); await mkdir(join(root2,'daemon.lock')); await writeFile(join(root2,'daemon.lock','owner.json'),'bad');
  await assert.rejects(new MonitorStore(root2).init(), {code:'LOCK_CORRUPT'});
});

test('unknown send attempt recovers to send_unknown and human handoff', async t => {
  const root=await temp(); t.after(()=>rm(root,{recursive:true,force:true})); const a=await new MonitorStore(root).init();
  await a.transaction(s=>{s.conversations.c1={status:'waiting_reply'};s.sentIntents.i1={conversationId:'c1',status:'send_attempt_started'};}); await a.close();
  const b=await new MonitorStore(root).init(); const snap=b.snapshot();
  assert.equal(snap.sentIntents.i1.status,'send_unknown'); assert.equal(snap.conversations.c1.human_handoff,true); assert.equal(snap.conversations.c1.status,'human_review'); assert.ok(snap.events.some(e=>e.type==='send_unknown_recovered')); await b.close();
});

test('event and notification history is bounded', async t => {
  const root=await temp(); t.after(()=>rm(root,{recursive:true,force:true})); const s=await new MonitorStore(root).init();
  await s.transaction(state=>{state.events=Array.from({length:2100},(_,i)=>({i}));state.notifications=Array.from({length:600},(_,i)=>({i}));});
  assert.equal(s.snapshot().events.length,2000); assert.equal(s.snapshot().notifications.length,500); await s.close();
});

test('close drains accepted transactions and immediately rejects new work', async t => {
  const root=await temp(); t.after(()=>rm(root,{recursive:true,force:true})); const s=await new MonitorStore(root).init();
  let release; const gate=new Promise(resolve=>{release=resolve;});
  const first=s.transaction(async state=>{await gate;state.runtime.done=true;});
  const closing=s.close();
  await assert.rejects(s.transaction(state=>{state.runtime.late=true;}), {code:'STORE_NOT_INITIALIZED'});
  release(); await first; await closing;
  assert.equal(JSON.parse(await readFile(join(root,'state.json'),'utf8')).runtime.done,true);
  await assert.rejects(s.init(),{code:'STORE_CLOSED'});
});

test('failed disk commit retains previous memory and disk state', async t => {
  const root=await temp(); t.after(()=>rm(root,{recursive:true,force:true})); const s=await new MonitorStore(root).init();
  await s.transaction(state=>{state.runtime.count=1;});
  const originalPath=s.statePath; const blockedPath=join(root,'blocked'); await mkdir(blockedPath); s.statePath=blockedPath;
  await assert.rejects(s.transaction(state=>{state.runtime.count=2;}),{code:'STATE_PERSIST_FAILED'});
  assert.equal(s.snapshot().runtime.count,1);
  assert.equal(JSON.parse(await readFile(originalPath,'utf8')).runtime.count,1);
  s.statePath=originalPath; await s.close();
});

test('unfinished stale-lock recovery fails closed', async t => {
  const root=await temp(); t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'daemon.lock')); await writeFile(join(root,'daemon.lock','owner.json'),JSON.stringify({pid:99999999,token:'old'}));
  await mkdir(join(root,'daemon.reclaim.lock'));
  await assert.rejects(new MonitorStore(root).init(),{code:'LOCK_STALE_UNCLEAR'});
  assert.equal(JSON.parse(await readFile(join(root,'daemon.lock','owner.json'),'utf8')).token,'old');
});
