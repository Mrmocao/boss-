import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {MonitorStore} from '../src/monitor-store.mjs';
import {ingestSnapshot} from '../src/monitor-core.mjs';
import {executeServicePlan,verifyAssessmentDownload} from '../src/service-sender.mjs';

const config={mode:'automatic',allowSend:true,debounceMs:30000,acceptedTitles:['数值策划'],maxConversations:100,expectedAccountDisplayName:'招聘员'};
const row={id:'c1',domRowId:'c1',name:'测试候选人',jobTitle:'数值策划'};
const plan={type:'send',messageId:'S1',text:'公司介绍，愿意做问卷吗？',nextStage:'waiting_consent'};
const msg=(text,direction='incoming')=>({text,direction,kind:'text'});
function snap(messages){return {account:{displayName:'招聘员'},rows:[row],selectedRow:row,activity:{typing:false,lastHumanAt:0},detail:{account:{displayName:'招聘员'},selected:row,candidate:{},messages}};}
async function fixture(t,{changed=false,unknown=false}={}){
 const dir=await mkdtemp(join(tmpdir(),'service-send-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=await new MonitorStore(dir).init();t.after(()=>store.close());
 await store.transaction(s=>{s.conversations.c1={...row,admitted:true,workflow:{stage:'screening'}};ingestSnapshot(s,snap([msg('想做策划')]),config,1000);});
 const fingerprint=store.snapshot().conversations.c1.fingerprint;let sends=0,filled=false;
 const browser={owner:'test',async poll(){return snap(changed?[msg('想做策划'),msg('薪资多少')]:sends?[msg('想做策划'),msg(plan.text,'outgoing')]:[msg('想做策划')]);},session:{async send(_method,{expression}){
   if(expression.includes('"action":"inspect"'))return {result:{value:{editorEmpty:true}}};
   if(expression.includes('"action":"fill"')){filled=true;return {result:{value:{filled:true}}};}
   if(expression.includes('"action":"send"')){sends++;return {result:{value:{clicked:true}}};}
   return {result:{value:{confirmed:!unknown,status:'送达'}}};
 }}};
 return {store,browser,fingerprint,get sends(){return sends;},get filled(){return filled;}};
}
test('automatic writer records intent before one click and advances only with receipt',async t=>{
 const f=await fixture(t);await executeServicePlan({...f,config,conversationId:'c1',plan,clock:()=>40000,delay:async()=>{}});
 assert.equal(f.sends,1);const s=f.store.snapshot();assert.equal(s.conversations.c1.workflow.stage,'waiting_consent');assert.equal(Object.values(s.sentIntents)[0].status,'sent_confirmed');
 await assert.rejects(executeServicePlan({...f,config,conversationId:'c1',plan,clock:()=>40000,delay:async()=>{}}));assert.equal(f.sends,1);
});
test('fresh inbound or less than 30 seconds prevents staging and sending',async t=>{
 const f=await fixture(t,{changed:true});await assert.rejects(executeServicePlan({...f,config,conversationId:'c1',plan,clock:()=>40000}),{code:'CONTEXT_CHANGED'});assert.equal(f.filled,false);assert.equal(f.sends,0);
 const g=await fixture(t);await assert.rejects(executeServicePlan({...g,config,conversationId:'c1',plan,clock:()=>20000}),{code:'QUIET_PERIOD_PENDING'});assert.equal(g.filled,false);
});
test('unknown delivery produces sticky handoff and does not retry or advance',async t=>{
 const f=await fixture(t,{unknown:true});await assert.rejects(executeServicePlan({...f,config,conversationId:'c1',plan,clock:()=>40000,delay:async()=>{}}),{code:'SEND_RECEIPT_UNKNOWN'});
 const s=f.store.snapshot();assert.equal(f.sends,1);assert.equal(s.conversations.c1.human_handoff,true);assert.equal(s.conversations.c1.workflow.stage,'screening');assert.equal(Object.values(s.sentIntents)[0].status,'send_unknown');
});
test('pause while staging blocks click and records a recoverable unsent intent',async t=>{
 const f=await fixture(t);let controls=0;
 await assert.rejects(executeServicePlan({...f,config,conversationId:'c1',plan,clock:()=>40000,delay:async()=>{},processControls:async()=>{if(++controls===2)await f.store.transaction(s=>{s.controls.paused=true;});}}),{code:'CONTEXT_CHANGED'});
 assert.equal(f.sends,0);assert.equal(Object.values(f.store.snapshot().sentIntents)[0].status,'not_sent');
});

test('signed assessment downloads use GET, preserve signature and validate workbook bytes',async()=>{
 const url='https://hr.example.test/exam.xlsx?Expires=1794382705&Signature=encoded%2Bvalue';let method;
 const result=await verifyAssessmentDownload({assessment:{url}},{clock:()=>1794300000000,fetchImpl:async(actual,options)=>{assert.equal(actual,url);method=options.method;return new Response(Buffer.from('504b0304000102','hex'));}});
 assert.equal(method,'GET');assert.equal(result.bytes,7);
});
test('expired signed URLs and successful HTML login pages never pass download checks',async()=>{
 await assert.rejects(verifyAssessmentDownload({assessment:{url:'https://hr.example.test/exam.xlsx?Expires=10'}},{fetchImpl:()=>assert.fail('must not fetch expired link')}),{code:'ASSESSMENT_LINK_EXPIRED_OR_INVALID'});
 await assert.rejects(verifyAssessmentDownload({assessment:{url:'https://hr.example.test/exam.xlsx'}},{fetchImpl:async()=>new Response('<html>login</html>')}),{code:'ASSESSMENT_DOWNLOAD_INVALID'});
});
test('explicit recovery of a known pre-click failure preserves its audit and sends once',async t=>{
 const f=await fixture(t);const id='auto-'+createHash('sha256').update('c1|'+f.fingerprint+'|'+plan.messageId+'|'+plan.text).digest('hex').slice(0,32);
 await f.store.transaction(s=>{s.sentIntents[id]={id,conversationId:'c1',status:'not_sent',error:'FILL_FAILED',text:plan.text};});
 const result=await executeServicePlan({...f,config,conversationId:'c1',plan,clock:()=>40000,delay:async()=>{}});
 assert.equal(f.sends,1);assert.notEqual(result.id,id);assert.equal(f.store.snapshot().sentIntents[id].status,'not_sent');assert.equal(f.store.snapshot().sentIntents[result.id].retryOf,id);
});
