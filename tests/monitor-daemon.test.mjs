import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MonitorStore} from '../src/monitor-store.mjs';
import {readMonitorConfig, runMonitor, processCommands, importSeed, readStatus} from '../src/monitor-daemon.mjs';
import {ingestSnapshot} from '../src/monitor-core.mjs';

async function folder(t) {
  const root=await mkdtemp(join(tmpdir(),'boss-daemon-test-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  return root;
}
function snapshot(rows=[]) {
  return {account:{displayName:'汪女士'},rows,selectedRow:null,detail:null,
    activity:{typing:false,lastHumanAt:0,humanConversationIds:[],manualConversationIds:[]},coverage:{fullScan:false}};
}
function fakeBrowser(value) {
  return {calls:[],target:{id:'test-target'},async connect(){this.calls.push('connect');return structuredClone(value);},
    async poll(){this.calls.push('poll');return structuredClone(value);},async scanStep(){this.calls.push('scanStep');return structuredClone(value);},
    async openConversation(){assert.fail('Unexpected conversation open');},async sendText(){assert.fail('Daemon must have no sending path');},
    async close(){this.calls.push('close');},async resumeConversation(){this.calls.push('resume');}};
}
async function command(root,{id,command,conversationId,createdAt,runId='run-test'}) {
  await mkdir(join(root,'commands'),{recursive:true});
  await writeFile(join(root,'commands',`${id}.json`),JSON.stringify({id,command,conversationId,createdAt,runId}));
}

test('seed import is idempotent, preserves sent receipt and does not overwrite later progress',async t=>{
  const root=await folder(t), store=await new MonitorStore(root).init();
  try {
    const config=await readMonitorConfig();
    const seedRoot=join(root,'seed'), id='test-seed-1';
    await mkdir(seedRoot);
    await writeFile(join(seedRoot,'intent.json'),JSON.stringify({
      id:'test-intent-1',profile:config.profile,account:{displayName:config.expectedAccountDisplayName},
      status:'sent_confirmed',candidate:{domRowId:id,name:'测试候选人',jobTitle:config.acceptedTitles[0]},
      text:'测试补问',receipt:{confirmed:true,status:'送达'},
    }));
    await writeFile(join(seedRoot,'state.json'),JSON.stringify({
      screening:{education:[],major:null,intent:null},clarificationCount:1,
    }));
    await importSeed(store,config,seedRoot);
    const s=store.snapshot();
    assert.equal(s.conversations[id].clarificationCount,1);
    assert.equal(s.conversations[id].status,'waiting_reply');
    assert.equal(Object.values(s.sentIntents)[0].status,'sent_confirmed');
    await store.transaction(s=>{s.conversations[id].human_handoff=true;s.conversations[id].status='human_review';});
    await importSeed(store,config,seedRoot);
    assert.equal(store.snapshot().conversations[id].status,'human_review');
    assert.equal(store.snapshot().events.filter(e=>e.type==='seed_imported').length,1);
  } finally {await store.close();}
});

test('one-shot observation persists baseline, closes browser, releases lock and never sends',async t=>{
  const root=await folder(t), config=await readMonitorConfig();
  const row={domRowId:'test-1',name:'测试候选人',jobTitle:'数值策划',lastMessagePreview:'你好',unreadCount:1};
  const browser=fakeBrowser(snapshot([row]));
  await runMonitor({once:true,root,config,browser,model:()=>assert.fail('Model disabled')});
  const s=JSON.parse(await readFile(join(root,'state.json'),'utf8'));
  assert.equal(s.runtime.sendEnabled,false);assert.equal(s.runtime.health,'stopped');
  assert.equal(s.runtime.listBaselineEstablished,true);assert.equal(s.conversations['test-1'].admitted,false);
  assert.deepEqual(browser.calls,['connect','close']);
  assert.equal((await readStatus(root)).running,false);
});

test('restart retains persisted baseline, notification de-dup keys and global manual pause',async t=>{
  const root=await folder(t), config=await readMonitorConfig();
  const store=await new MonitorStore(root).init();
  await store.transaction(s=>{
    s.imports={singleConversationV1:'test'};s.controls.paused=true;
    s.runtime={listBaselineEstablished:true,notificationKeys:{keep:true},priorObserved:'yes'};
  });
  await store.close();
  const browser=fakeBrowser(snapshot());
  await runMonitor({once:true,root,config,browser});
  const s=JSON.parse(await readFile(join(root,'state.json'),'utf8'));
  assert.equal(s.runtime.listBaselineEstablished,true);assert.equal(s.runtime.notificationKeys.keep,true);
  assert.equal(s.controls.paused,true);assert.deepEqual(browser.calls,['close']);
});

test('stop command preserves global pause; stale-run command is rejected with receipt',async t=>{
  const root=await folder(t), store=await new MonitorStore(root).init();
  try {
    await store.transaction(s=>{s.controls.paused=true;});
    const stopId='11111111-1111-4111-8111-111111111111', staleId='22222222-2222-4222-8222-222222222222';
    await command(root,{id:stopId,command:'stop',createdAt:'2026-11-06T10:00:00Z'});
    await command(root,{id:staleId,command:'resume',createdAt:'2026-11-06T10:00:01Z',runId:'old-run'});
    await processCommands(store,fakeBrowser(snapshot()),root,'run-test');
    assert.equal(store.snapshot().controls.stopRequested,true);assert.equal(store.snapshot().controls.paused,true);
    assert.equal(JSON.parse(await readFile(join(root,'receipts',`${stopId}.json`),'utf8')).ok,true);
    assert.equal(JSON.parse(await readFile(join(root,'receipts',`${staleId}.json`),'utf8')).ok,false);
  } finally {await store.close();}
});

test('control mailbox executes creation order instead of lexical random UUID order',async t=>{
  const root=await folder(t), store=await new MonitorStore(root).init();
  try {
    await command(root,{id:'ffffffff-ffff-4fff-8fff-ffffffffffff',command:'pause',createdAt:'2026-11-06T10:00:00Z'});
    await command(root,{id:'11111111-1111-4111-8111-111111111111',command:'resume',createdAt:'2026-11-06T10:00:01Z'});
    await processCommands(store,fakeBrowser(snapshot()),root,'run-test');
    assert.equal(store.snapshot().controls.paused,false);
  } finally {await store.close();}
});

test('retry model cannot cause self-reply when latest message is outgoing',async t=>{
  const root=await folder(t), store=await new MonitorStore(root).init();
  try {
    await store.transaction(s=>{s.conversations.c1={id:'c1',admitted:true,status:'waiting_reply',fingerprint:'outbound',processedFingerprint:'outbound',messages:[{direction:'outgoing',text:'请问您是否有策划意向？'}],detail:{messages:[{direction:'outgoing',text:'请问您是否有策划意向？'}]},pendingAt:null};});
    const id='11111111-1111-4111-8111-111111111111';
    await command(root,{id,command:'retry-model',conversationId:'c1',createdAt:'2026-11-06T10:00:00Z'});
    await processCommands(store,fakeBrowser(snapshot()),root,'run-test');
    assert.equal(store.snapshot().conversations.c1.pendingAt,null);
    assert.equal(JSON.parse(await readFile(join(root,'receipts',`${id}.json`),'utf8')).ok,false);
  } finally {await store.close();}
});

for (const change of ['new incoming','human takeover']) test(`model draft is discarded after ${change} during generation`,async t=>{
  const root=await folder(t), config=await readMonitorConfig();
  const names={baseUrlEnv:'BOSS_TEST_DAEMON_URL',modelEnv:'BOSS_TEST_DAEMON_MODEL',apiKeyEnv:'BOSS_TEST_DAEMON_KEY'};
  for (const [key,value] of Object.entries({BOSS_TEST_DAEMON_URL:'https://model.example/v1',BOSS_TEST_DAEMON_MODEL:'fake',BOSS_TEST_DAEMON_KEY:'test-key'})) {
    const prior=process.env[key];process.env[key]=value;t.after(()=>{if(prior===undefined)delete process.env[key];else process.env[key]=prior;});
  }
  config.model={...config.model,...names,enabled:true};
  const row={domRowId:'c1',name:'测试候选人',jobTitle:'数值策划',lastMessagePreview:'我想做策划',unreadCount:1};
  const before=snapshot([row]);before.selectedRow=row;
  before.detail={account:before.account,selected:row,candidate:{educationText:[]},messages:[{direction:'incoming',kind:'text',text:'我想做策划'}]};
  const after=structuredClone(before);
  if(change==='new incoming') after.detail.messages.push({direction:'incoming',kind:'text',text:'我还有一个问题'});
  else after.activity.humanConversationIds=['c1'];
  const store=await new MonitorStore(root).init();
  await store.transaction(s=>{s.imports={singleConversationV1:'test'};s.conversations.c1={id:'c1',...row,admitted:true};ingestSnapshot(s,before,config,Date.now()-10000);});
  await store.close();
  const browser=fakeBrowser(before);browser.poll=async()=>structuredClone(after);
  let calls=0;
  await runMonitor({once:true,root,config,browser,model:async()=>{calls++;return {action:'ask',reply:'旧上下文草稿',reason:'测试',evidence:[],missingFields:[]};}});
  const s=JSON.parse(await readFile(join(root,'state.json'),'utf8'));
  assert.equal(calls,1);assert.equal(s.conversations.c1.draft,undefined);assert.equal(s.conversations.c1.processedFingerprint,null);
  if(change==='human takeover')assert.equal(s.conversations.c1.human_handoff,true);
});

test('explicit resume cannot clear a new human input observed during resume verification',async t=>{
  const root=await folder(t), config=await readMonitorConfig(), store=await new MonitorStore(root).init();
  try {
    const row={domRowId:'c1',name:'测试候选人',jobTitle:'数值策划'};
    const current=snapshot([row]);current.selectedRow=row;
    current.detail={account:current.account,selected:row,candidate:{},messages:[{direction:'incoming',kind:'text',text:'您好'}]};
    current.activity.typing=true;current.activity.humanConversationIds=['c1'];current.activity.lastHumanAt=Date.now();
    await store.transaction(s=>{s.conversations.c1={id:'c1',...row,admitted:true,human_handoff:true,status:'human_review'};});
    const browser=fakeBrowser(current), id='11111111-1111-4111-8111-111111111111';
    await command(root,{id,command:'resume-conversation',conversationId:'c1',createdAt:'2026-11-06T10:00:00Z'});
    await processCommands(store,browser,root,'run-test',config);
    assert.equal(store.snapshot().conversations.c1.human_handoff,true);
    assert.equal(JSON.parse(await readFile(join(root,'receipts',`${id}.json`),'utf8')).ok,false);
  } finally {await store.close();}
});

test('restart requires fresh detail before processing a queued conversation outside the visible list',async t=>{
  const root=await folder(t), config=await readMonitorConfig(), store=await new MonitorStore(root).init();
  await store.transaction(s=>{
    s.imports={singleConversationV1:'test'};s.runtime.listBaselineEstablished=true;
    s.conversations.c1={id:'c1',domRowId:'c1',name:'测试候选人',jobTitle:'数值策划',admitted:true,needsDetail:false,human_handoff:false,
      status:'chatting',fingerprint:'old-detail',processedFingerprint:null,pendingAt:Date.now()-60000,
      detail:{messages:[{direction:'incoming',kind:'text',text:'你好'}]},messages:[{direction:'incoming',kind:'text',text:'你好'}]};
  });
  await store.close();
  await runMonitor({once:true,root,config,browser:fakeBrowser(snapshot()),model:()=>assert.fail('No old detail processing')});
  const s=JSON.parse(await readFile(join(root,'state.json'),'utf8'));
  assert.equal(s.conversations.c1.needsDetail,true);
  assert.equal(s.conversations.c1.processedFingerprint,null);
  assert.equal(s.notifications.filter(n=>n.conversationId==='c1').length,0);
});
