import test from 'node:test';
import assert from 'node:assert/strict';
import {loadWorkflowPolicy,planWorkflow,screenCandidate,validateAnalysis,recoverWorkflow,confirmWorkflowSend} from '../src/recruiting-workflow.mjs';
import {ingestSnapshot,dueConversations} from '../src/monitor-core.mjs';
import {applyMailReceipt} from '../src/mail-receipts.mjs';
const policy=await loadWorkflowPolicy();
const config={mode:'automatic',allowSend:true,allowAssessment:true,acceptedTitles:['数值策划'],maxConversations:100,debounceMs:30000,expectedAccountDisplayName:'招聘员',assessment:{delivery:'link',url:'https://recruiting.example.org/exam.xlsx'}};
const row={id:'c1',domRowId:'c1',name:'测试候选人',jobTitle:'数值策划',unreadCount:1};
const msg=(text,direction='incoming')=>({text,direction,kind:'text'});
const candidate=()=>({...row,admitted:true,clarificationCount:0,workflow:{stage:'screening'},messages:[msg('本科 信息与计算科学 已毕业，我想做游戏策划')],detail:{candidate:{educationText:['某大学 · 信息与计算科学 · 本科']}}});
const analysis=()=>({education:[{level:'本科',major:'信息与计算科学',stage:'graduated',source:'profile_education',quote:'某大学 · 信息与计算科学 · 本科',stageEvidence:{source:'candidate_message',quote:'已毕业'}}],intent:{value:'yes',source:'candidate_message',quote:'我想做游戏策划'},consent:{value:'unknown',quote:''},concern:{kind:'none',quote:''}});
const state=()=>({conversations:{c1:candidate()},sentIntents:{},controls:{},runtime:{},events:[],notifications:[]});
const snapshot=messages=>({account:{displayName:'招聘员'},rows:[row],selectedRow:row,activity:{},detail:{account:{displayName:'招聘员'},selected:row,candidate:{educationText:[]},messages}});

test('automatic batching waits 30 seconds from latest inbound and survives snapshot repetition',()=>{
 const s=state();delete s.conversations.c1.messages;ingestSnapshot(s,snapshot([msg('你好')]),config,1000);assert.equal(dueConversations(s,config,30999).length,0);
 ingestSnapshot(s,snapshot([msg('你好'),msg('还有补充')]),config,20000);assert.equal(dueConversations(s,config,49999).length,0);
 ingestSnapshot(s,snapshot([msg('你好'),msg('还有补充')]),config,30000);assert.equal(dueConversations(s,config,50000).length,1);
});
test('canonical pass sends S1, requires actual receipt and explicit consent before S3',()=>{
 const c=candidate(),a=analysis();validateAnalysis(a,c);const plan=planWorkflow(c,a,policy,config,{});assert.equal(plan.messageId,'S1');
 c.workflow.stage='waiting_consent';a.consent={value:'yes',quote:'愿意'};assert.equal(planWorkflow(c,a,policy,config,{}).type,'handoff');
 const intent={id:'s1',conversationId:c.id,messageId:'S1',text:plan.text,status:'sent_confirmed'};
 c.messages.push(msg(plan.text,'outgoing'),msg('愿意'));
 const s3=planWorkflow(c,a,policy,config,{s1:intent});assert.equal(s3.messageId,'S3');assert.ok(s3.text.includes('hr-rpg@youkia.net'));assert.ok(s3.receiptToken);assert.ok(s3.text.includes('姓名-岗位-提交日期'));assert.ok(!s3.text.includes('BOSS-'));assert.ok(!s3.text.includes('回收编号'));
 const blocked=planWorkflow(c,a,policy,{...config,assessment:{}},{s1:intent});assert.equal(blocked.type,'blocked');
 a.consent.value='unknown';assert.equal(planWorkflow(c,a,policy,config,{s1:intent}).type,'handoff');
 a.consent.value='no';assert.equal(planWorkflow(c,a,policy,config,{s1:intent}).messageId,'DECLINE_TEST');
});
test('S6 only once, counter increases only after receipt, optional games never block',()=>{
 const c=candidate(),a=analysis();a.education=[];
 const p=planWorkflow(c,a,policy,config);assert.equal(p.messageId,'S6');assert.equal(c.clarificationCount,0);
 const s=state();s.conversations.c1=c;confirmWorkflowSend(s,'c1',p,'confirmed');assert.equal(c.clarificationCount,1);
 assert.equal(planWorkflow(c,a,policy,config).type,'handoff');
 assert.equal(screenCandidate(analysis(),policy).outcome,'pass');
});

test('file delivery needs no URL but still requires consent and retains the collection address',()=>{
 const c=candidate();c.workflow.stage='waiting_consent';const s1={id:'s1',conversationId:c.id,messageId:'S1',status:'sent_confirmed',text:'愿意做问卷吗？'};
 c.messages.push(msg(s1.text,'outgoing'),msg('愿意'));const a=analysis();a.consent={value:'yes',quote:'愿意'};
 const p=planWorkflow(c,a,policy,{...config,assessment:{filePath:'C:/project/招聘辅助助手/试题.xlsx'}},{s1});
 assert.equal(p.type,'send_file');assert.equal(p.delivery,'file');assert.ok(p.text.includes('hr-rpg@youkia.net'));assert.ok(!p.text.includes('https://'));assert.ok(!p.text.includes('BOSS-'));assert.ok(p.text.includes('姓名-岗位-提交日期'));
 a.consent.value='unknown';assert.equal(planWorkflow(c,a,policy,{...config,assessment:{filePath:'C:/exam.xlsx'}},{s1}).type,'handoff');
});
test('salary and abnormal requests take priority over all workflow stages and attachments',()=>{
 const c=candidate();c.messages.push(msg('薪资是多少'));c.detail.attachmentRequests=[{status:'pending'}];
 assert.equal(planWorkflow(c,analysis(),policy,config).messageId,'S5');
});
test('attachment handling preserves stage and does not skip consent',()=>{
 const c=candidate();c.workflow.stage='waiting_consent';c.detail.attachmentRequests=[{status:'pending'}];
 const p=planWorkflow(c,analysis(),policy,config);assert.equal(p.type,'reject_attachment');assert.equal(p.messageId,'S7');assert.equal(p.nextStage,'waiting_consent');
});
test('outside whitelist goes to human, explicit highest low degree rejects, missing is never failed',()=>{
 const a=analysis();a.education[0].major='环境工程';assert.equal(screenCandidate(a,policy).outcome,'review');
 a.education=[];assert.equal(screenCandidate(a,policy).outcome,'missing');
 a.highestEducation={level:'大专',quote:'最高学历大专',source:'candidate_message'};assert.equal(screenCandidate(a,policy).outcome,'fail');
});
test('invented quote, mismatched level and missing consent evidence are rejected',()=>{
 const c=candidate();for(const mutate of [a=>a.education[0].level='博士',a=>a.intent.quote='没有说过',a=>a.consent={value:'yes',quote:'同意'}]){const a=analysis();mutate(a);assert.throws(()=>validateAnalysis(a,c),{code:'MODEL_ANALYSIS_INVALID'});}
});
test('consent recognizes contextual 有空的 without accepting conditional agreement',()=>{
 const c=candidate();c.messages.push(msg('你有空做问卷吗','outgoing'),msg('您好，有空的'));const a=analysis();a.consent={value:'yes',quote:'您好，有空的'};assert.equal(validateAnalysis(a,c).consent.value,'yes');
 c.messages.push(msg('有空再考虑'));a.consent.quote='有空';assert.throws(()=>validateAnalysis(a,c),{code:'MODEL_ANALYSIS_INVALID'});
});
test('migration uses S1 receipt without resending; truthful identity answer never claims human',()=>{
 const c=candidate();delete c.workflow;recoverWorkflow(c,{old:{id:'old',conversationId:'c1',status:'sent_confirmed',messageId:'S1'}});assert.equal(c.workflow.stage,'waiting_consent');
 c.messages=[msg('你是不是AI')];assert.ok(planWorkflow(c,analysis(),policy,config).text.includes('自动化助手'));
});
test('mail joins exact token only after sent S3, requires distinct files and same sender, deduplicates',()=>{
 const s=state(),c=s.conversations.c1;c.workflow={stage:'waiting_email',receiptToken:'BOSS-1234567890ABCDEF'};
 s.sentIntents.s3={conversationId:'c1',messageId:'S3',status:'sent_confirmed',receipt:{observedAt:'2026-11-10T00:00:00Z'}};
 const mail={id:'1',token:c.workflow.receiptToken,recipient:'hr-rpg@youkia.net',sender:'candidate@example.test',date:'2026-11-10T01:00:00Z',attachments:[{role:'questionnaire',sha256:'q'}]};
 assert.equal(applyMailReceipt(s,mail),false);assert.equal(c.workflow.stage,'submission_incomplete');
 assert.equal(applyMailReceipt(s,{...mail,id:'2',sender:'other@example.test',attachments:[{role:'resume',sha256:'r'}]}),false);
 assert.equal(applyMailReceipt(s,{...mail,id:'3',attachments:[{role:'resume',sha256:'r'}]}),true);assert.equal(c.workflow.stage,'awaiting_review');
 const count=s.notifications.length;assert.equal(applyMailReceipt(s,{...mail,id:'3'}),false);assert.equal(s.notifications.length,count);
});

test('normal mail subject matches unique sent candidate and date, ambiguous names require review',()=>{
 const s=state(),c=s.conversations.c1;c.workflow={stage:'waiting_email'};
 s.sentIntents.s3={conversationId:c.id,messageId:'S3',status:'sent_confirmed',receipt:{observedAt:'2026-11-10T00:00:00Z'}};
 const mail={id:'normal',subject:'测试候选人-数值策划-2026-11-11',submissionSubject:{name:c.name,jobTitle:c.jobTitle,date:'2026-11-11'},recipient:'hr-rpg@youkia.net',sender:'person@example.test',date:'2026-11-10T17:00:00Z',attachments:[{role:'questionnaire',sha256:'q'},{role:'resume',sha256:'r'}]};
 const ambiguous=structuredClone(s);ambiguous.conversations.c2={...structuredClone(c),id:'c2'};ambiguous.sentIntents.s32={...s.sentIntents.s3,conversationId:'c2'};
 assert.equal(applyMailReceipt(ambiguous,mail),false);assert.ok(ambiguous.notifications.at(-1).reason.includes('同名'));
 const wrongDate=structuredClone(s);assert.equal(applyMailReceipt(wrongDate,{...mail,submissionSubject:{...mail.submissionSubject,date:'2026-11-10'}}),false);
 assert.equal(applyMailReceipt(s,mail),true);assert.equal(c.workflow.stage,'awaiting_review');
 assert.equal(c.submission.identityBasis,'unique_name_job_submission_date_and_consistent_sender');
});
