import test from 'node:test';
import assert from 'node:assert/strict';
import {ingestSnapshot,dueConversations,applyModelResult,markHandoff} from '../src/monitor-core.mjs';

const config={acceptedTitles:['数值策划'],maxConversations:3,debounceMs:100};
const row=(id,extra={})=>({domRowId:id,name:`候选人${id}`,jobTitle:'数值策划',lastMessagePreview:'你好',displayTime:'昨天',...extra});
const msg=(text,direction='incoming')=>({text,direction,kind:'text'});
const state=()=>({account:null,conversations:{},events:[],notifications:[],runtime:{},controls:{paused:false}});
const snap=(rows,selected,messages)=>({account:{displayName:'招聘账户'},rows,activity:{},...(selected?{
  selectedRow:selected,detail:{account:{displayName:'招聘账户'},selected,candidate:{name:selected.name},messages}}:{})});
function seed(s,id='1') {s.conversations[id]={...row(id),id,admitted:true,needsDetail:true};return s.conversations[id];}

test('initial list establishes a baseline without admitting or opening old conversations',()=>{
  const s=state();ingestSnapshot(s,snap([row('1'),row('2')]),config,1);
  assert.equal(Object.values(s.conversations).some(r=>r.admitted || r.needsDetail),false);
  assert.deepEqual(dueConversations(s,config,1000),[]);
});

test('changed and new eligible rows admit at most three, unread decrease does not trigger work',()=>{
  const s=state();ingestSnapshot(s,snap([row('1',{unreadCount:2})]),config,1);
  ingestSnapshot(s,snap([row('1',{unreadCount:0})]),config,2);
  assert.equal(s.conversations['1'].admitted,false);
  const result=ingestSnapshot(s,snap([row('1',{lastMessagePreview:'新消息'}),row('2'),row('3'),row('4'),row('5',{jobTitle:'UI'})]),config,3);
  assert.deepEqual(result.admittedIds,['1','2','3']);
  assert.equal(s.conversations['4'].admitted,false);assert.equal(s.conversations['5'].admitted,false);
  assert.equal(s.conversations['1'].needsDetail,true);
});

test('seed detail follows incoming tail, debounce and processed fingerprint prevent duplicate processing',()=>{
  const s=state();seed(s);const observation=snap([row('1')],row('1'),[msg('你好')]);
  ingestSnapshot(s,observation,config,10);
  assert.equal(dueConversations(s,config,109).length,0);assert.equal(dueConversations(s,config,110).length,1);
  const fingerprint=s.conversations['1'].fingerprint;
  applyModelResult(s,'1',fingerprint,{status:'ok',action:'ask',draft:'请介绍游戏经历',questions:['游戏经历']},111);
  ingestSnapshot(s,observation,config,120);
  assert.equal(dueConversations(s,config,1000).length,0);
  assert.deepEqual(s.conversations['1'].questionsAsked,[]);
  assert.deepEqual(s.conversations['1'].suggestedQuestions,['游戏经历']);
});

test('new incoming messages requeue once and stale model results cannot overwrite newer context',()=>{
  const s=state();seed(s);ingestSnapshot(s,snap([row('1')],row('1'),[msg('你好')]),config,1);
  const old=s.conversations['1'].fingerprint;
  ingestSnapshot(s,snap([row('1',{lastMessagePreview:'补充'})],row('1'),[msg('你好'),msg('补充')]),config,20);
  assert.equal(applyModelResult(s,'1',old,{status:'ok',draft:'旧回复'},30).applied,false);
  assert.equal(dueConversations(s,config,120).length,1);
});

test('initial outgoing history waits, imported outgoing is recognized, new unknown outgoing forces sticky handoff',()=>{
  const s=state();const r=seed(s);r.knownOutboundContents=['已导入发送'];
  ingestSnapshot(s,snap([row('1')],row('1'),[msg('旧问候','outgoing')]),config,1);
  assert.equal(r.status,'waiting_reply');assert.equal(r.human_handoff,false);
  ingestSnapshot(s,snap([row('1')],row('1'),[msg('旧问候','outgoing'),msg('已导入发送','outgoing')]),config,2);
  assert.equal(r.human_handoff,false);
  ingestSnapshot(s,snap([row('1')],row('1'),[msg('旧问候','outgoing'),msg('已导入发送','outgoing'),msg('人工插话','outgoing')]),config,3);
  assert.equal(r.human_handoff,true);
  ingestSnapshot(s,snap([row('1')],row('1'),[msg('旧问候','outgoing'),msg('已导入发送','outgoing'),msg('人工插话','outgoing'),msg('回复')]),config,4);
  assert.deepEqual(dueConversations(s,config,1000),[]);
});

test('manual input and explicit handoff remain paused across observations and restart',()=>{
  let s=state();seed(s);const observation=snap([row('1')],row('1'),[msg('你好')]);
  observation.activity={humanConversationIds:['1']};ingestSnapshot(s,observation,config,1);
  s=JSON.parse(JSON.stringify(s));observation.activity={};ingestSnapshot(s,observation,config,2);
  assert.equal(s.conversations['1'].human_handoff,true);assert.equal(dueConversations(s,config,1000).length,0);
  markHandoff(s,'1','manual',3);markHandoff(s,'1','manual',4);
  assert.equal(s.notifications.filter(n=>n.reason==='manual').length,1);
});

test('account and recycled identity failures do not partially apply the snapshot',()=>{
  const s=state();ingestSnapshot(s,snap([row('1')]),config,1);const before=structuredClone(s);
  assert.throws(()=>ingestSnapshot(s,{...snap([row('1')]),account:{displayName:'另一个账户'}},config,2),{code:'ACCOUNT_CHANGED'});
  assert.throws(()=>ingestSnapshot(s,snap([row('2'),row('1',{name:'同名不同人'})]),config,2),{code:'IDENTITY_CHANGED'});
  assert.deepEqual(s,before);
});

test('unconfigured or failed model produces a single local todo and never asks questions or rejects a candidate',()=>{
  const s=state();seed(s);ingestSnapshot(s,snap([row('1')],row('1'),[msg('你好')]),config,1);
  const fingerprint=s.conversations['1'].fingerprint;
  assert.equal(applyModelResult(s,'1',fingerprint,{status:'unconfigured'},2).applied,true);
  assert.equal(applyModelResult(s,'1',fingerprint,{status:'unconfigured'},3).applied,false);
  assert.equal(s.notifications.length,1);assert.deepEqual(s.conversations['1'].questionsAsked,[]);
  assert.equal(dueConversations(s,config,1000).length,0);
});

test('history window discontinuity and observer reset require review',()=>{
  const s=state();seed(s);ingestSnapshot(s,snap([row('1')],row('1'),[msg('你好')]),config,1);
  ingestSnapshot(s,snap([row('1')],row('1'),[msg('不连续历史')]),config,2);
  assert.equal(s.conversations['1'].handoffReason,'message_window_discontinuity');
  ingestSnapshot(s,{...snap([row('1')]),activity:{observerReset:true}},config,3);
  assert.equal(s.controls.paused,true);
});

test('draft facts are suggestions, not confirmed facts or sent questions',()=>{
  const s=state();seed(s);ingestSnapshot(s,snap([row('1')],row('1'),[msg('你好')]),config,1);
  applyModelResult(s,'1',s.conversations['1'].fingerprint,{status:'ok',action:'reject',facts:{education:'本科'},questions:['学历'],draft:'草稿'},2);
  const r=s.conversations['1'];assert.deepEqual(r.facts,{});assert.deepEqual(r.questionsAsked,[]);
  assert.equal(r.status,'draft_ready');assert.equal(r.suggestedFacts.education,'本科');
});

test('display-time rollover and old fingerprint format never admit historical rows',()=>{
  const s=state();ingestSnapshot(s,snap([row('1')]),config,1);
  s.conversations['1'].rowFingerprint='legacy-fingerprint-including-display-time';
  const result=ingestSnapshot(s,snap([row('1',{displayTime:'周五'})]),config,2);
  assert.deepEqual(result.admittedIds,[]);assert.deepEqual(result.changedIds,[]);
  assert.equal(s.conversations['1'].admitted,false);
  assert.equal(s.conversations['1'].needsDetail,undefined);
  const next=ingestSnapshot(s,snap([row('1',{displayTime:'周五',unreadCount:1})]),config,3);
  assert.deepEqual(next.admittedIds,['1']);
});

test('manual selection pauses other conversations for 15 seconds but only its own handoff is sticky',()=>{
  const s=state();seed(s,'1');seed(s,'2');
  const observation=snap([row('1'),row('2')],row('2'),[msg('来自另一个候选人的消息')]);
  observation.activity={lastHumanAt:1000,manualSelection:true,manualConversationIds:['1']};
  ingestSnapshot(s,observation,config,1001);
  assert.equal(s.runtime.humanActive,true);assert.equal(s.conversations['1'].human_handoff,true);
  assert.deepEqual(dueConversations(s,config,1100),[]);
  ingestSnapshot(s,observation,config,16000);
  assert.equal(s.runtime.humanActive,false);assert.equal(s.conversations['1'].human_handoff,true);
  assert.deepEqual(dueConversations(s,config,16000).map(r=>r.id),['2']);
  observation.activity.typing=true;ingestSnapshot(s,observation,config,17000);
  assert.equal(s.runtime.humanActive,true);assert.equal(s.conversations['2'].human_handoff,true);
});
