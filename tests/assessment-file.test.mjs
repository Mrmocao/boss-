import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MonitorStore} from '../src/monitor-store.mjs';
import {ingestSnapshot} from '../src/monitor-core.mjs';
import {executeAssessmentFile,prepareAssessmentFile} from '../src/assessment-file.mjs';
import {executeServicePlan} from '../src/service-sender.mjs';

const row={id:'c1',domRowId:'c1',name:'候选人',jobTitle:'数值策划'};
const msg=(text,direction='incoming',kind='text')=>({text,direction,kind});
const messages=[msg('愿意做问卷吗？','outgoing'),msg('愿意')];
const snapshot=uploaded=>({account:{displayName:'招聘员'},rows:[row],selectedRow:row,activity:{typing:false},detail:{account:{displayName:'招聘员'},selected:row,candidate:{},messages:uploaded?[...messages,msg('试题.xlsx','outgoing','attachment')]:messages}});
const plan={type:'send_file',messageId:'S3',filePath:'',receiptToken:'BOSS-1234567890ABCDEF',text:'问卷文件已发，请将问卷与简历发送至 hr-rpg@youkia.net',nextStage:'waiting_email'};
async function fixture(t,options={}){
 const root=await mkdtemp(join(tmpdir(),'assessment-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const path=join(root,'试题.xlsx');await writeFile(path,Buffer.from('504b030400010203','hex'));
 const config={mode:'automatic',allowSend:true,allowAssessment:true,debounceMs:30000,maxConversations:100,acceptedTitles:['数值策划'],expectedAccountDisplayName:'招聘员',assessment:{filePath:path}};
 const store=await new MonitorStore(join(root,'state')).init();t.after(()=>store.close());
 await store.transaction(s=>{s.conversations.c1={...row,admitted:true,workflow:{stage:'waiting_consent'},analysis:{consent:{value:options.noConsent?'unknown':'yes'}},knownOutboundContents:[messages[0].text]};s.sentIntents.s1={id:'s1',conversationId:'c1',messageId:'S1',status:'sent_confirmed',text:messages[0].text};ingestSnapshot(s,snapshot(false),config,1000);});
 let uploaded=0,textSent=0;
 const browser={owner:'owner',async poll(){return snapshot(uploaded>0);},session:{async send(method,args){
   if(method==='DOM.describeNode')return {node:{nodeName:'INPUT',backendNodeId:1}};
   if(method==='DOM.setFileInputFiles'){uploaded++;return {};}
   if(args.returnByValue===false)return {result:{subtype:'node',objectId:'input'}};
   if(args.expression.includes('"action":"receipt"'))return {result:{value:{confirmed:!options.unknown,status:'送达'}}};
   if(args.expression.includes('"action":"confirm_preview"'))return {result:{value:{clicked:false}}};
   if(args.expression.includes('function filePageAction'))return {result:{value:options.noInput?{blocked:'FILE_UPLOAD_UNAVAILABLE'}:{available:true,existingFiles:0}}};
   return {result:{value:{editorEmpty:true}}};
 }}};
 const textSender=async({store,plan})=>{textSent++;assert.equal(store.snapshot().sentIntents[plan.fileIntentId].status,'sent_confirmed');assert.equal(store.snapshot().conversations.c1.workflow.stage,'assessment_file_sent');return {sent:true};};
 return {root,config,store,browser,textSender,outbox:join(root,'outbox'),conversationId:'c1',fingerprint:store.snapshot().conversations.c1.fingerprint,plan:{...plan,filePath:path},clock:()=>40000,delay:async()=>{},get uploaded(){return uploaded;},get textSent(){return textSent;}};
}
test('upload begins only with S1 receipt, consent and quiet period',async t=>{
 const f=await fixture(t,{noConsent:true});await assert.rejects(executeAssessmentFile(f),{code:'CONSENT_REQUIRED'});assert.equal(f.uploaded,0);
 const g=await fixture(t);await assert.rejects(executeAssessmentFile({...g,clock:()=>20000}),{code:'QUIET_PERIOD_PENDING'});assert.equal(g.uploaded,0);
});
test('missing real upload input creates handoff, never a synthetic input or a sent claim',async t=>{
 const f=await fixture(t,{noInput:true});await assert.rejects(executeAssessmentFile(f),{code:'FILE_UPLOAD_UNAVAILABLE'});assert.equal(f.uploaded,0);assert.equal(f.textSent,0);assert.equal(Object.keys(f.store.snapshot().sentIntents).length,1);assert.equal(f.store.snapshot().conversations.c1.human_handoff,true);
});
test('file receipt is durable before the collection instructions and retries cannot re-upload',async t=>{
 const f=await fixture(t);await executeAssessmentFile(f);assert.equal(f.uploaded,1);assert.equal(f.textSent,1);
 assert.ok(f.store.snapshot().conversations.c1.pendingAssessment);
 await assert.rejects(executeAssessmentFile(f));assert.equal(f.uploaded,1);
});
test('unknown upload delivery preserves unknown intent and never sends misleading instructions',async t=>{
 const f=await fixture(t,{unknown:true});await assert.rejects(executeAssessmentFile(f),{code:'FILE_RECEIPT_UNKNOWN'});assert.equal(f.uploaded,1);assert.equal(f.textSent,0);
 assert.ok(Object.values(f.store.snapshot().sentIntents).some(i=>i.messageId==='S3_FILE'&&i.status==='send_unknown'));assert.equal(f.store.snapshot().conversations.c1.human_handoff,true);
});
test('verified copy is immutable when the original workbook changes',async t=>{
 const f=await fixture(t);const file=await prepareAssessmentFile(f.config.assessment.filePath,f.outbox);await writeFile(f.config.assessment.filePath,'modified');assert.equal((await readFile(file.path)).toString('hex'),'504b030400010203');
 await assert.rejects(prepareAssessmentFile(f.config.assessment.filePath,f.outbox),{code:'ASSESSMENT_FILE_INVALID'});
});
test('S3 file instructions cannot bypass the file delivery receipt check',async t=>{
 const f=await fixture(t);
 await assert.rejects(executeServicePlan({...f,plan:{...plan,type:'send',delivery:'file',fileIntentId:'missing'}}),{code:'FILE_RECEIPT_REQUIRED'});
});
