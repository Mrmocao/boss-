import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {MonitorStore} from '../src/monitor-store.mjs';
import {ingestSnapshot,markHandoff} from '../src/monitor-core.mjs';
import {handoffReviewAt,canReviewHandoff,reviewIdleHandoff} from '../src/handoff-recovery.mjs';
import {loadWorkflowPolicy} from '../src/recruiting-workflow.mjs';
import {runMonitor} from '../src/monitor-daemon.mjs';
const policy=await loadWorkflowPolicy();const NOW=Date.parse('2026-11-13T15:00:00+08:00');
const config={mode:'automatic',autoResumeHandoff:true,humanReplyTimeoutMs:600000,expectedAccountDisplayName:'招聘员',acceptedTitles:['数值策划'],maxConversations:100,debounceMs:30000,recentWindowHours:24};
const row={id:'c1',domRowId:'c1',name:'甲',jobTitle:'数值策划',displayTime:'14:40',lastMessagePreview:'我已毕业，想做游戏策划'};
const msg=(text,direction='incoming')=>({direction,kind:'text',text});
const snap=()=>({account:{displayName:'招聘员'},rows:[row],selectedRow:row,activity:{typing:false,hasDraft:false,lastHumanAt:0},detail:{account:{displayName:'招聘员'},selected:row,candidate:{educationText:[]},messages:[msg(row.lastMessagePreview)]}});
const analysis=()=>({education:[{level:'本科',major:'信息与计算科学',stage:'graduated'}],intent:{value:'yes'},consent:{value:'unknown'},concern:{kind:'none'}});
const baseState=()=>({conversations:{},runtime:{},controls:{},events:[],notifications:[],sentIntents:{}});
function makeState(){const s=baseState();s.conversations.c1={...row,admitted:true,workflow:{stage:'screening'}};ingestSnapshot(s,snap(),config,NOW-1200000);markHandoff(s,'c1','explicit_manual_takeover',NOW-600000);return s;}
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'handoff-recovery-'));const store=await new MonitorStore(root).init();t.after(async()=>{await store.close();await rm(root,{recursive:true,force:true});});await store.transaction(s=>Object.assign(s,makeState()));let resumes=0,opens=0;const browser={async openConversation(_c,options){assert.equal(options.reviewOnly,true);opens++;return snap();},async poll(){return snap();},async resumeConversation(){resumes++;}};return {store,browser,config,policy,clock:()=>NOW,analyzer:async()=>analysis(),get resumes(){return resumes;},get opens(){return opens;}};}
test('ten minute boundary, recent human activity and restart-persisted timer',()=>{
 const s=makeState(),c=s.conversations.c1;assert.equal(handoffReviewAt(c,config),NOW);assert.equal(canReviewHandoff(s,c,config,NOW-1),false);assert.equal(canReviewHandoff(s,c,config,NOW),true);
 c.handoff.lastActivityAt=new Date(NOW-1000).toISOString();assert.equal(canReviewHandoff(s,c,config,NOW),false);
 const restored=JSON.parse(JSON.stringify(s));assert.equal(handoffReviewAt(restored.conversations.c1,config),NOW+599000);
});
test('valid current context resumes without sending; subsequent normal worker retains all send guards',async t=>{
 const f=await fixture(t);const result=await reviewIdleHandoff(f);assert.equal(result.resumed,true);assert.equal(f.resumes,1);assert.equal(f.store.snapshot().conversations.c1.human_handoff,false);assert.equal(Object.keys(f.store.snapshot().sentIntents).length,0);assert.equal(f.store.snapshot().notifications.filter(n=>n.type==='handoff_auto_resumed').length,1);
});
test('salary and outside-whitelist stay in handoff with bounded recheck, no page marker clearing',async t=>{
 const f=await fixture(t);f.analyzer=async()=>({...analysis(),concern:{kind:'salary'}});assert.equal((await reviewIdleHandoff(f)).resumed,false);assert.equal(f.resumes,0);assert.equal(f.store.snapshot().conversations.c1.human_handoff,true);assert.equal((await reviewIdleHandoff(f)).reviewed,false);
});
test('unknown sends, pause, queued reply, draft and old conversations cannot start automatic recovery',()=>{
 for(const change of [s=>s.controls.paused=true,s=>s.controls.stopRequested=true,s=>s.conversations.c1.humanReply={id:'q'},s=>s.conversations.c1.handoff.draftPresent=true,s=>s.sentIntents.i={conversationId:'c1',status:'send_unknown'},s=>s.conversations.c1.handoff.autoResumeBlocked=true,s=>s.conversations.c1.row.displayTime='11月01日']){
  const s=makeState();change(s);assert.equal(canReviewHandoff(s,s.conversations.c1,config,NOW),false);
 }
});
test('human reply during generation invalidates automatic recovery',async t=>{
 const f=await fixture(t);f.analyzer=async()=>{await f.store.transaction(s=>{s.conversations.c1.humanReply={id:'q'};});return analysis();};assert.equal((await reviewIdleHandoff(f)).resumed,false);assert.equal(f.resumes,0);assert.equal(f.store.snapshot().conversations.c1.human_handoff,true);
});
test('new inbound or manual takeover during generation is not overwritten',async t=>{
 for(const race of ['incoming','takeover']){
  const f=await fixture(t);let generated=false;f.analyzer=async()=>{generated=true;if(race==='takeover')await f.store.transaction(s=>markHandoff(s,'c1','explicit_manual_takeover',NOW));return analysis();};
  f.browser.poll=async()=>{const s=snap();if(generated&&race==='incoming')s.detail.messages.push(msg('还有一个问题'));return s;};
  assert.equal((await reviewIdleHandoff(f)).resumed,false);assert.equal(f.store.snapshot().conversations.c1.human_handoff,true);assert.equal(f.resumes,0);
 }
});
test('last outgoing is read but never triggers self reply or clears the handoff',async t=>{
 const f=await fixture(t);f.browser.openConversation=async()=>{const s=snap();s.detail.messages.push(msg('人工已回复','outgoing'));return s;};
 assert.equal((await reviewIdleHandoff(f)).resumed,false);assert.equal(f.resumes,0);assert.equal(f.store.snapshot().conversations.c1.lastManualReplyAt,new Date(NOW).toISOString());
});
test('live editor draft or active human protects the conversation despite elapsed timeout',async t=>{
 const f=await fixture(t);f.browser.openConversation=async()=>({...snap(),activity:{typing:true,hasDraft:true,lastHumanAt:NOW}});assert.equal((await reviewIdleHandoff(f)).resumed,false);assert.equal(f.resumes,0);
});

test('daemon recovers an idle handoff and routes a fresh eligible plan through its normal sender',async t=>{
 const f=await fixture(t),root=f.store.rootDir;await f.store.close();
 t.mock.method(Date,'now',()=>NOW);let sends=0;
 const browser={...f.browser,target:{id:'mock'},async connect(){return snap();},async close(){}};
 await runMonitor({once:true,root,browser,config:{...config,profile:'company-2',allowSend:true,allowAssessment:false,tickMs:2000,reconcileMs:180000,rulesFile:'config/jobs/game-execution-planner.yaml',model:{enabled:false}},policy,analyzer:async()=>analysis(),sender:async({plan})=>{sends++;assert.equal(plan.messageId,'S1');}});
 assert.equal(sends,1);
});

test('same unresolved question is rechecked at most once per ten minutes after restart',async t=>{
 const f=await fixture(t);f.analyzer=async()=>({...analysis(),education:[],intent:{value:'unknown'}});await f.store.transaction(s=>{s.conversations.c1.clarificationCount=1;});
 assert.equal((await reviewIdleHandoff(f)).resumed,false);
 const after=f.store.snapshot();assert.equal(after.conversations.c1.handoff.reviewStatus,'needs_human');
 const restored=JSON.parse(JSON.stringify(after));assert.equal(canReviewHandoff(restored,restored.conversations.c1,config,NOW+599999),false);assert.equal(canReviewHandoff(restored,restored.conversations.c1,config,NOW+600000),true);
});
