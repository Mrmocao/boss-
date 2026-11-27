import {createHash,randomUUID} from 'node:crypto';
import {portfolioTemplates} from './portfolio-workflow.mjs';
import {followupExpression} from './authorized-followup.mjs';
import {ingestSnapshot,markHandoff} from './monitor-core.mjs';
import {confirmWorkflowSend,questionnaireUrl} from './recruiting-workflow.mjs';

const fail=code=>{throw Object.assign(new Error(code),{code});};
const now=()=>new Date().toISOString();

export async function verifyAssessmentDownload(config,{fetchImpl=fetch,clock=Date.now}={}) {
  const url=questionnaireUrl(config,clock());if(!url)fail('ASSESSMENT_LINK_EXPIRED_OR_INVALID');
  let response;
  try{response=await fetchImpl(url,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000)});}catch{fail('ASSESSMENT_LINK_UNREACHABLE');}
  if(!response.ok){await response.body?.cancel().catch(()=>{});fail('ASSESSMENT_LINK_UNREACHABLE');}
  if(!response.body?.getReader)fail('ASSESSMENT_DOWNLOAD_INVALID');
  const reader=response.body.getReader();let bytes=0;const chunks=[];
  try{for(;;){const r=await reader.read();if(r.done)break;bytes+=r.value.length;if(bytes>10000000)fail('ASSESSMENT_DOWNLOAD_TOO_LARGE');chunks.push(r.value);}}
  catch(e){if(e.code?.startsWith('ASSESSMENT_'))throw e;fail('ASSESSMENT_LINK_UNREACHABLE');}
  finally{await reader.cancel().catch(()=>{});}
  const data=Buffer.concat(chunks);
  if(data.length<4||data.subarray(0,4).toString('hex')!=='504b0304')fail('ASSESSMENT_DOWNLOAD_INVALID');
  return {bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')};
}

/** Uses the daemon's sole store/browser owner; never opens another writer. */
export async function executeServicePlan({store,browser,config,conversationId,fingerprint,plan,processControls=async()=>{},clock=Date.now,delay=ms=>new Promise(r=>setTimeout(r,ms)),fetchImpl=fetch}) {
  let attempted=false,prepared=false;
  const baseId='auto-'+createHash('sha256').update(conversationId+'|'+fingerprint+'|'+plan.messageId+'|'+plan.text).digest('hex').slice(0,32);
  let id=baseId;
  const allowed=new Set(['S1','S3','S4','S6','S7','DECLINE_TEST','IDENTITY','HUMAN']);
  if(plan.messageId==='PORTFOLIO_INVITE'){
    const title=store.snapshot().conversations[conversationId]?.jobTitle;
    const job=config.jobProfiles?.jobs.find(j=>j.id===plan.portfolioJobId&&j.acceptedTitles.includes(title));
    if(job?.delivery==='automatic'&&job.status==='manual_portfolio'&&portfolioTemplates(job.prompt).S2===plan.text)allowed.add('PORTFOLIO_INVITE');
  }
  if(plan.messageId==='FLOW_REPLY'){
    const candidate=store.snapshot().conversations[conversationId];
    const job=config.jobProfiles?.jobs.find(j=>j.status==='dynamic'&&j.id===plan.flowRule?.jobId&&j.acceptedTitles.includes(candidate?.jobTitle));
    const rule=job?.flow.rules.find(r=>r.id===plan.flowRule.id);
    const delivered=candidate?.workflow?.flowProgress;
    const prior=delivered?.jobId===job?.id ? delivered?.delivered||[] : [];
    if(rule?.action==='reply'&&rule.text===plan.text&&!prior.includes(rule.id)&&(!rule.after||prior.includes(rule.after)))allowed.add('FLOW_REPLY');
  }
  if(config.mode!=='automatic'||config.allowSend!==true||!allowed.has(plan.messageId)||typeof plan.text!=='string'||!plan.text.trim()||plan.text.length>1500)fail('AUTO_SEND_NOT_ALLOWED');
  if(plan.messageId==='S3'){
    if(!config.allowAssessment)fail('ASSESSMENT_NOT_CONFIGURED');
    if(plan.delivery==='file'){
      const state=store.snapshot(),file=state.sentIntents[plan.fileIntentId],pending=state.conversations[conversationId]?.pendingAssessment;
      if(!file||file.messageId!=='S3_FILE'||file.status!=='sent_confirmed'||file.conversationId!==conversationId||pending?.fileIntentId!==file.id||pending?.fingerprint!==fingerprint||pending?.text!==plan.text||pending.receiptToken!==plan.receiptToken)fail('FILE_RECEIPT_REQUIRED');
    }else{
      if(!config.assessment?.url)fail('ASSESSMENT_NOT_CONFIGURED');
      await verifyAssessmentDownload(config,{fetchImpl,clock});
    }
  }
  const check=()=>{
    const s=store.snapshot(),c=s.conversations[conversationId];
    if(!c||!c.admitted||s.controls.paused||s.controls.stopRequested||s.runtime.humanActive||c.needsDetail||c.fingerprint!==fingerprint)fail('CONTEXT_CHANGED');
    if(c.human_handoff&&!plan.humanReply)fail('HUMAN_HANDOFF');
    if(clock()-(c.lastInboundObservedAt??c.pendingAt??clock())<Math.max(30000,config.debounceMs||0))fail('QUIET_PERIOD_PENDING');
    if((c.messages||[]).findLast(m=>['incoming','outgoing','unknown'].includes(m.direction))?.direction!=='incoming'&&!(plan.messageId==='S7'&&c.pendingAttachmentGuidance)&&!(plan.messageId==='S3'&&plan.delivery==='file'&&c.pendingAssessment?.fileIntentId===plan.fileIntentId&&c.pendingAssessment?.fingerprint===fingerprint))fail('WAITING_FOR_PEER');
    return c;
  };
  let c=check();
  const duplicate=Object.values(store.snapshot().sentIntents).find(i=>i.conversationId===conversationId&&(['send_unknown','send_attempt_started'].includes(i.status)||(i.text===plan.text&&i.status==='sent_confirmed')));
  if(duplicate)fail('DUPLICATE_OR_UNKNOWN_OUTBOUND');
  const previous=store.snapshot().sentIntents[id];
  if(previous){
    if(previous.status!=='not_sent'||previous.attemptedAt)fail('INTENT_ALREADY_RECORDED');
    // Explicit recovery after a pre-click failure retains the original audit record.
    id=baseId+'-retry-'+randomUUID().slice(0,8);
  }
  try {
    let snapshot=await browser.poll({force:true});
    if(snapshot.selectedRow?.domRowId!==c.domRowId)snapshot=await browser.openConversation(c);
    await store.transaction(s=>ingestSnapshot(s,snapshot,config,clock()));
    await processControls();c=check();
    if(snapshot.activity.typing||snapshot.activity.handoffRequired)fail('HUMAN_ACTIVE');
    await store.transaction(s=>{s.sentIntents[id]={id,retryOf:previous?baseId:null,conversationId,text:plan.text,messageId:plan.messageId,workflowStage:plan.nextStage,status:'prepared',fileIntentId:plan.fileIntentId||null,createdAt:now(),authorization:'用户于2026-11-10授权按配置的S1–S7持续自动处理'};});prepared=true;
    const act=async(action,messages=snapshot.detail.messages)=>{
      const result=await browser.session.send('Runtime.evaluate',{expression:followupExpression({action,text:plan.text,expected:c,messages,account:config.expectedAccountDisplayName,owner:browser.owner}),returnByValue:true,timeout:4000});
      if(result.exceptionDetails||!result.result?.value||result.result.value.blocked)fail(result.result?.value?.blocked||'EDITOR_ACTION_FAILED');
      return result.result.value;
    };
    if(!(await act('inspect')).editorEmpty)fail('DRAFT_PRESENT');
    if(!(await act('fill')).filled)fail('FILL_FAILED');
    await delay(350);await processControls();check();
    if(plan.messageId==='S3'&&plan.delivery!=='file'&&!questionnaireUrl(config,clock()))fail('ASSESSMENT_LINK_EXPIRED_OR_INVALID');
    // DOM guard revalidates latest messages and human activity immediately before clicking.
    await store.transaction(s=>{s.sentIntents[id].status='send_attempt_started';s.sentIntents[id].attemptedAt=now();});attempted=true;
    await act('send');
    let after,receipt;
    for(let i=0;i<12;i++) {
      await delay(500);
      try{after=await browser.poll({force:true});}catch(e){if(['CONVERSATION_MISMATCH','OBSERVATION_CHANGED','DETAIL_CHANGED'].includes(e.code))continue;throw e;}
      if(!after.selectedRow){after=await browser.openConversation(c);}
      if(after.selectedRow?.domRowId!==conversationId)fail('IDENTITY_CHANGED');
      const verification=await act('receipt',after.detail.messages);
      if(verification.confirmed){receipt={status:verification.status,observedAt:now(),editorEmpty:true};break;}
    }
    if(!receipt)fail('SEND_RECEIPT_UNKNOWN');
    await store.transaction(s=>{
      const record=s.conversations[conversationId];
      record.knownOutboundContents=[...new Set([...(record.knownOutboundContents||[]),plan.text])];
      Object.assign(s.sentIntents[id],{status:'sent_confirmed',receipt});
      if(plan.messageId==='PORTFOLIO_INVITE')Object.assign(s.sentIntents[id],{portfolioJobId:plan.portfolioJobId,candidateName:record.name});record.lastOutbound={intentId:id,text:plan.text,receipt};
      ingestSnapshot(s,after,config,clock());
      confirmWorkflowSend(s,conversationId,plan,id);
      if(plan.humanReply){record.human_handoff=true;record.status='human_review';record.lastManualReplyAt=now();record.handoff={...record.handoff,lastRepliedAt:now(),replyQueued:false,draftPresent:false,reviewVersion:(record.handoff?.reviewVersion||0)+1};}
      s.events.push({type:'automatic_send_confirmed',conversationId,messageId:plan.messageId,at:now()});
    });
    return {sent:true,id,receipt};
  } catch(e) {
    await store.transaction(s=>{
      if(prepared){s.sentIntents[id].status=attempted?'send_unknown':'not_sent';s.sentIntents[id].error=e.code||'SEND_FAILED';}
      if(prepared||attempted)markHandoff(s,conversationId,attempted?'发送结果不明，请核对，禁止自动重发':'发送前检查失败，保留编辑框供人工检查');
    });throw e;
  }
}
