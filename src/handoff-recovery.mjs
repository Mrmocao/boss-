import {createHash} from 'node:crypto';
import {contextForJob} from './job-settings.mjs';
import {isRecentRow} from './recent-conversations.mjs';
import {ingestSnapshot} from './monitor-core.mjs';
import {planWorkflow,recoverWorkflow} from './recruiting-workflow.mjs';

export const HUMAN_REPLY_TIMEOUT_MS=10*60*1000;
const time=value=>typeof value==='number'&&Number.isFinite(value)?value:Date.parse(value)||0;
const lastMessage=c=>(c.messages||[]).findLast(m=>['incoming','outgoing','unknown'].includes(m.direction));
const protectedReason=reason=>/send_unknown|SEND_RECEIPT_UNKNOWN|发送结果不明|禁止.*重发|IDENTITY|ACCOUNT|身份|账号|message_window_discontinuity|历史.*不连续|窗口.*断|附件.*未确认|文件.*未全部确认/.test(reason||'');
export function pendingOutbound(state,cid){return Object.values(state.sentIntents||{}).some(i=>i.conversationId===cid&&['prepared','send_attempt_started','send_unknown'].includes(i.status));}
export function handoffReviewAt(c,config={}){
 const interval=Math.max(HUMAN_REPLY_TIMEOUT_MS,config.humanReplyTimeoutMs||HUMAN_REPLY_TIMEOUT_MS);
 const started=Math.max(time(c.handoff?.openedAt),time(c.handoff?.lastActivityAt),time(c.handoff?.lastRepliedAt),time(c.lastManualReplyAt));
 return started?Math.max(started+interval,time(c.handoff?.nextReviewAt)):null;
}
export function canReviewHandoff(state,c,config,now=Date.now(),{ignoreSchedule=false}={}){
 if(config.mode!=='automatic'||config.autoResumeHandoff!==true||state.controls?.paused||state.controls?.stopRequested)return false;
 if(!c?.admitted||!c.human_handoff||!config.acceptedTitles.includes(c.jobTitle)||c.humanReply||c.handoff?.replyQueued||c.handoff?.draftPresent)return false;
 if(c.handoff?.autoResumeBlocked||protectedReason(c.handoffReason)||pendingOutbound(state,c.id))return false;
 if(['rejected_screening','declined_test','do_not_contact','stopped','awaiting_review','assessment_file_sent'].includes(c.workflow?.stage))return false;
 if(!isRecentRow(c.row,config,now,c)||state.runtime?.hasHumanDraft||now-time(state.runtime?.lastHumanActivityAt)<15000)return false;
 const at=handoffReviewAt(c,config);if(at===null||(!ignoreSchedule&&now<at))return false;
 // Unknown/stale detail is read again; a known answered conversation is left alone.
 if(lastMessage(c)?.direction==='outgoing'&&!c.needsDetail&&c.row?.lastMessagePreview===lastMessage(c).text)return false;
 return true;
}
const contextVersion=c=>JSON.stringify([c.handoff?.openedAt,c.handoff?.lastActivityAt,c.handoff?.lastRepliedAt,c.handoff?.draftPresent,c.handoffReason,c.humanReply?.id,c.handoff?.reviewVersion||0,c.lastManualReplyAt]);
const incomingVersion=c=>JSON.stringify((c.messages||[]).filter(m=>m.direction==='incoming').map(m=>[m.kind,m.text||m.displayText]));
function safeSnapshot(snapshot,c,config,now){
 return snapshot?.account?.displayName===config.expectedAccountDisplayName&&snapshot.selectedRow?.domRowId===c.id
  &&snapshot.selectedRow?.name===c.name&&snapshot.selectedRow?.jobTitle===c.jobTitle
  &&!snapshot.activity?.typing&&!snapshot.activity?.hasDraft&&now-time(snapshot.activity?.lastHumanAt)>=HUMAN_REPLY_TIMEOUT_MS;
}

/** Re-evaluate one idle handoff, without sending or clearing it until a fresh in-scope plan exists. */
export async function reviewIdleHandoff({store,browser,config,policy,analyzer,processControls=async()=>{},clock=Date.now}){
 const candidate=Object.values(store.snapshot().conversations).filter(c=>canReviewHandoff(store.snapshot(),c,config,clock()))
  .sort((a,b)=>handoffReviewAt(a,config)-handoffReviewAt(b,config))[0];
 if(!candidate)return {reviewed:false};
 const cid=candidate.id;
 // Persist a bounded retry interval before doing network/UI work, surviving service restarts.
 await store.transaction(s=>{s.conversations[cid].handoff={...s.conversations[cid].handoff,lastReviewAt:new Date(clock()).toISOString(),nextReviewAt:new Date(clock()+HUMAN_REPLY_TIMEOUT_MS).toISOString(),reviewStatus:'checking'};});
 const expectedVersion=contextVersion(store.snapshot().conversations[cid]);
 const stillEligible=()=>{const s=store.snapshot(),c=s.conversations[cid];return contextVersion(c)===expectedVersion&&canReviewHandoff(s,c,config,clock(),{ignoreSchedule:true});};
 const finish=async(status,reason)=>{await store.transaction(s=>{const c=s.conversations[cid];if(c.human_handoff&&contextVersion(c)===expectedVersion)Object.assign(c.handoff,{reviewStatus:status,reviewReason:reason});});return {reviewed:true,resumed:false,reason};};
 try{
  await processControls();if(!stillEligible())return finish('deferred','人工操作或会话状态已变化');
  let snapshot=await browser.openConversation(candidate,{reviewOnly:true});
  if(!safeSnapshot(snapshot,candidate,config,clock()))return finish('deferred','页面仍有人工操作、草稿或身份不一致');
  await store.transaction(s=>ingestSnapshot(s,snapshot,config,clock()));await processControls();
  if(!stillEligible())return finish('deferred','新消息或人工操作需要重新核验');
  let c=store.snapshot().conversations[cid];
  if(lastMessage(c)?.direction!=='incoming')return finish('waiting_peer','最后消息不是候选人来信，不重复回复');
  if(clock()-(c.lastInboundObservedAt||0)<Math.max(30000,config.debounceMs||0))return finish('waiting_quiet','等待新来信停止满30秒');
  const fingerprint=c.fingerprint,incoming=incomingVersion(c);
  const reviewCandidate=structuredClone(c);reviewCandidate.human_handoff=false;recoverWorkflow(reviewCandidate,store.snapshot().sentIntents);
  const {config:reviewConfig,policy:reviewPolicy}=contextForJob(config,policy,reviewCandidate.jobTitle);
  const analysis=await analyzer({config:reviewConfig,conversation:reviewCandidate,policy:reviewPolicy});
  snapshot=await browser.poll({force:true});
  if(!safeSnapshot(snapshot,c,config,clock()))return finish('deferred','生成期间发生人工操作');
  await store.transaction(s=>ingestSnapshot(s,snapshot,config,clock()));await processControls();
  c=store.snapshot().conversations[cid];
  if(!stillEligible()||c.fingerprint!==fingerprint||incomingVersion(c)!==incoming)return finish('deferred','生成期间上下文改变，未恢复自动发送');
  const plan=planWorkflow({...structuredClone(c),human_handoff:false},analysis,reviewPolicy,reviewConfig,store.snapshot().sentIntents);
  if(!['send','send_file','reject_attachment'].includes(plan.type))return finish('needs_human',plan.reason||'仍不符合自动回复条件');
  // Clear only stale page interaction markers after all business checks have passed.
  await browser.resumeConversation(c);
  snapshot=await browser.poll({force:true});
  if(!safeSnapshot(snapshot,c,config,clock()))return finish('deferred','恢复前检测到人工操作');
  await store.transaction(s=>ingestSnapshot(s,snapshot,config,clock()));await processControls();
  let resumed=false;
  await store.transaction(s=>{
   const current=s.conversations[cid];
   if(contextVersion(current)!==expectedVersion||current.fingerprint!==fingerprint||!canReviewHandoff(s,current,config,clock(),{ignoreSchedule:true}))return;
   current.human_handoff=false;delete current.handoffReason;current.needsDetail=false;current.processedFingerprint=null;
   current.pendingAt=current.lastInboundObservedAt||clock();current.status='chatting';current.analysis=analysis;
   current.handoff={...current.handoff,resolvedAt:new Date(clock()).toISOString(),resolution:'idle_10min_policy_recheck',reviewStatus:'auto_resumed',reviewReason:'超过10分钟无人工回复，最新上下文符合规则'};
   current.autoResume={at:new Date(clock()).toISOString(),fingerprint,plannedMessageId:plan.messageId};
   const key='handoff-resume:'+createHash('sha256').update(cid+'|'+expectedVersion+'|'+fingerprint).digest('hex');
   if(!s.notifications.some(n=>n.key===key))s.notifications.push({key,type:'handoff_auto_resumed',conversationId:cid,reason:'人工超过10分钟未回复，已核验规则并恢复自动处理',at:new Date(clock()).toISOString()});
   s.events.push({type:'handoff_auto_resumed',conversationId:cid,at:new Date(clock()).toISOString()});resumed=true;
  });
  return {reviewed:true,resumed};
 }catch(e){return finish('deferred',e.code||'回检未完成，稍后再检查');}
}
