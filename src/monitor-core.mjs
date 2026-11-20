import { createHash } from 'node:crypto';
import {isRecentRow,shouldInspectConversation} from './recent-conversations.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code, message) => { throw Object.assign(new Error(message), {code}); };
const identity = row => ['domRowId','name','jobTitle'].map(k=>row?.[k]);
// Display times/receipt labels can change without a new message.
const messageKey = m => hash([m.direction,m.kind,m.text || m.displayText || '']);
// Display-time labels roll over without a new message (e.g. yesterday -> Friday).
const rowFingerprint = row => hash([row.lastMessagePreview ?? null]);
const eligible = (record,config) => config.acceptedTitles.includes(record.jobTitle);
const timestamp = now => new Date(now).toISOString();

function notifyOnce(state,key,notification) {
  state.runtime.notificationKeys ??= {};
  if (state.runtime.notificationKeys[key]) return;
  state.runtime.notificationKeys[key] = true;
  state.notifications.push({key,...notification});
}
function initialize(record) {
  record.id ??= record.domRowId;
  record.admitted ??= true;
  record.facts ??= {}; record.evidence ??= []; record.questionsAsked ??= [];
  if (!Number.isInteger(record.clarificationCount)) record.clarificationCount = 0;
  record.knownOutboundContents ??= [];
  record.human_handoff ??= false; record.status ??= 'pending_information';
  record.pendingAt ??= null; record.processedFingerprint ??= null;
}

export function markHandoff(state,id,reason,now=Date.now()) {
  const record=state.conversations[id]; if (!record) return false;
  initialize(record);
  const newCycle=!record.human_handoff;
  record.human_handoff=true; record.status='human_review'; record.handoffReason=reason;
  record.pendingAt=null; record.needsDetail=false;
  record.handoff = {...record.handoff, reason, openedAt:newCycle?timestamp(now):record.handoff?.openedAt||timestamp(now), resolvedAt:null,
    reviewVersion:(record.handoff?.reviewVersion||0)+1,
    ...(newCycle?{nextReviewAt:null,reviewStatus:null,reviewReason:null}:{}),
    ...(reason==='explicit_manual_takeover'?{lastActivityAt:timestamp(now)}:{})};
  if(/send_unknown|SEND_RECEIPT_UNKNOWN|发送结果不明|IDENTITY|ACCOUNT|message_window_discontinuity|身份|账号|禁止.*重发/.test(reason||''))record.handoff.autoResumeBlocked=true;
  notifyOnce(state,`handoff:${id}:${reason}`,{type:'human_handoff',conversationId:id,reason,observedAt:timestamp(now)});
  return true;
}

/** Mutates only the caller's transaction draft. Never opens conversations or sends text. */
export function ingestSnapshot(state,snapshot,config,now=Date.now()) {
  if (!Array.isArray(config.acceptedTitles) || !config.acceptedTitles.length) fail('CONFIG_INVALID','acceptedTitles is required.');
  if (!snapshot.account?.displayName || !Array.isArray(snapshot.rows)) fail('SNAPSHOT_INVALID','Verified account and rows are required.');
  if (state.account?.displayName && state.account.displayName!==snapshot.account.displayName) fail('ACCOUNT_CHANGED','Account changed; discard observation.');
  const seen=new Set();
  for (const row of snapshot.rows) {
    if (!identity(row).every(v=>typeof v==='string' && v) || seen.has(row.domRowId)) fail('IDENTITY_INVALID','Row identity is missing or duplicated.');
    seen.add(row.domRowId);
    if(state.archivedConversations?.[row.domRowId])continue;
    const prior=state.conversations[row.domRowId];
    if (prior && identity(prior).some((v,i)=>v!==identity(row)[i])) fail('IDENTITY_CHANGED','Candidate name or position changed under a known row id.');
  }
  const detail=snapshot.detail;
  if (detail) {
    const row=snapshot.rows.find(r=>r.domRowId===detail.selected?.domRowId);
    if (!row || detail.account?.displayName!==snapshot.account.displayName || identity(row).some((v,i)=>v!==identity(detail.selected)[i])
        || (snapshot.selectedRow && identity(row).some((v,i)=>v!==identity(snapshot.selectedRow)[i])))
      fail('DETAIL_IDENTITY_CHANGED','Detail does not match the observed account and row.');
    if (!Array.isArray(detail.messages)) fail('SNAPSHOT_INVALID','Detail messages must be an array.');
  }
  state.account={...state.account,...snapshot.account}; state.runtime ??= {};
  const baseline=!state.runtime.listBaselineEstablished;
  const max=Math.min(config.mode==='automatic'?1000:3,Math.max(0,Number.isInteger(config.maxConversations)?config.maxConversations:3));
  let admitted=Object.values(state.conversations).filter(r=>r.admitted!==false).length;
  const admittedIds=[],changedIds=[];
  for (const row of snapshot.rows) {
    if(state.archivedConversations?.[row.domRowId])continue;
    let record=state.conversations[row.domRowId]; const existing=!!record;
    const current=rowFingerprint(row);
    // Recompute from the stored row to migrate older time-sensitive fingerprints safely.
    const changed=existing && record.row && rowFingerprint(record.row)!==current;
    const unreadIncreased=existing && Number(row.unreadCount || 0)>Number(record.row?.unreadCount || 0);
    if (!record) record=state.conversations[row.domRowId]={id:row.domRowId,...Object.fromEntries(['domRowId','name','jobTitle'].map(k=>[k,row[k]])),admitted:false,firstObservedAt:timestamp(now)};
    initialize(record);
    const newEvent=!baseline && (!existing || changed || unreadIncreased);
    if(existing&&(changed||unreadIncreased))record.lastLiveChangeAt=now;
    const recent=isRecentRow(row,config,now,record);
    if (recent&&(newEvent || (config.mode==='automatic' && config.processExistingUnread && Number(row.unreadCount)>0)) && !record.admitted && eligible(record,config) && admitted<max) {
      record.admitted=true; admitted++; admittedIds.push(record.id);
      record.admittedAt=timestamp(now);
      record.needsDetail=true;record.pendingAt=now;
    }
    if (recent&&record.admitted && eligible(record,config) && newEvent && !record.human_handoff && record.status!=='stopped') {
      record.needsDetail=true; record.pendingAt=now; changedIds.push(record.id);
    }
    record.row=structuredClone(row); record.rowFingerprint=current; record.lastObservedAt=timestamp(now);
  }
  state.runtime.listBaselineEstablished=true;
  state.runtime.lastObservedAt=timestamp(now); state.runtime.coverage=structuredClone(snapshot.coverage || {});
  const lastHumanAt=Number(snapshot.activity?.lastHumanAt || 0);
  state.runtime.lastHumanActivityAt=Math.max(state.runtime.lastHumanActivityAt||0,lastHumanAt);
  state.runtime.hasHumanDraft=!!snapshot.activity?.typing||!!snapshot.activity?.hasDraft;
  state.runtime.humanActive=!!snapshot.activity?.typing || (lastHumanAt>0 && now-lastHumanAt<15_000)
    || (snapshot.activity?.humanConversationIds||[]).length>0
    || ((snapshot.activity?.manualConversationIds||[]).length>0 && lastHumanAt>0 && now-lastHumanAt<15_000);
  if (snapshot.activity?.observerReset) {
    state.controls.paused=true;
    notifyOnce(state,'observer_reset',{type:'human_handoff',reason:'observer_reset',observedAt:timestamp(now)});
  }
  const humanIds=new Set([...(snapshot.activity?.humanConversationIds || []),...(snapshot.activity?.manualConversationIds || [])]);
  if (snapshot.activity?.typing && snapshot.selectedRow?.domRowId) humanIds.add(snapshot.selectedRow.domRowId);
  for (const id of humanIds) {
    const record=state.conversations[id];
    if (record) {
      record.temporaryHumanPauseUntil=now+15_000;
      if(record.human_handoff&&lastHumanAt>0)record.handoff={...record.handoff,lastActivityAt:timestamp(Math.max(Date.parse(record.handoff?.lastActivityAt)||0,lastHumanAt))};
    }
  }
  if (detail) {
    const record=state.conversations[detail.selected.domRowId];
    if (record?.admitted && eligible(record,config)) ingestDetail(state,record,detail,now);
  }
  return {admittedIds,changedIds};
}

function ingestDetail(state,record,detail,now) {
  const messages=structuredClone(detail.messages);
  const keys=messages.map(messageKey); const previous=record.messages?.map(messageKey) || record.messageKeys;
  const fingerprint=hash([keys,detail.candidate || {}]);
  let added=messages;
  if (previous?.length) {
    let overlap=0;
    for (let size=Math.min(previous.length,keys.length);size>0;size--) {
      if (previous.slice(-size).every((key,i)=>key===keys[i])) {overlap=size;break;}
    }
    if (!overlap && hash(previous)!==hash(keys)) markHandoff(state,record.id,'message_window_discontinuity',now);
    added=overlap?messages.slice(overlap):[];
  }
  if (previous && added.some(m=>m.direction==='outgoing' && !record.knownOutboundContents.includes(m.text || m.displayText || ''))) {
    record.lastManualReplyAt=timestamp(now);
    markHandoff(state,record.id,'unrecognized_outgoing_message',now);
    record.handoff.lastRepliedAt=timestamp(now);
  }
  const changed=fingerprint!==record.fingerprint;
  record.detail=structuredClone(detail); record.messages=messages; record.messageKeys=keys;
  record.fingerprint=fingerprint; record.needsDetail=false;
  record.lastMessage=messages.at(-1) || null;
  record.lastOutgoing=messages.findLast(m=>m.direction==='outgoing') || record.lastOutgoing || null;
  const last=messages.findLast(m=>m.direction==='incoming' || m.direction==='outgoing' || m.direction==='unknown');
  const lastOutgoingIndex=messages.findLast(m=>m.direction==='outgoing')?.localIndex??-1;
  const newAttachment=(detail.attachmentRequests||[]).some(r=>r.status==='pending'&&r.messageIndex>lastOutgoingIndex);
  if(changed&&last?.direction==='incoming')record.lastInboundObservedAt=now;
  if (record.human_handoff || record.status==='stopped') return;
  if(newAttachment&&fingerprint!==record.processedFingerprint){if(changed){record.pendingAt=now;record.lastInboundObservedAt=now;}record.status='chatting';return;}
  if(record.pendingAttachmentGuidance&&fingerprint!==record.processedFingerprint){record.pendingAt??=now;record.status='chatting';return;}
  if (last?.direction==='unknown') { markHandoff(state,record.id,'unknown_message_direction',now); return; }
  if (last?.direction==='outgoing' || !last) {
    record.pendingAt=null; record.status='waiting_reply'; return;
  }
  if (changed && fingerprint!==record.processedFingerprint) {record.pendingAt=now;record.lastInboundObservedAt=now;record.status='chatting';}
  if (fingerprint===record.processedFingerprint) record.pendingAt=null;
}

export function dueConversations(state,config,now=Date.now()) {
  if (state.controls?.paused || state.controls?.stopRequested || state.runtime?.humanActive) return [];
  return Object.values(state.conversations).filter(r=>r.admitted && eligible(r,config) && !r.human_handoff && r.status!=='stopped'
    && !(r.temporaryHumanPauseUntil>now)
    && shouldInspectConversation(r,config,now)
    && !r.needsDetail && r.detail && r.pendingAt!==null && r.pendingAt!==undefined && now-r.pendingAt>=Math.max(config.mode==='automatic'?30000:0,config.debounceMs || 0)
    && r.fingerprint && r.fingerprint!==r.processedFingerprint).sort((a,b)=>a.pendingAt-b.pendingAt);
}

/** Model output is a reviewable suggestion. It never counts as a sent question or a hiring decision. */
export function applyModelResult(state,id,fingerprint,result,now=Date.now()) {
  const record=state.conversations[id];
  if (!record || record.fingerprint!==fingerprint || record.needsDetail || record.human_handoff || record.status==='stopped'
      || state.controls?.paused || state.controls?.stopRequested || state.runtime?.humanActive) return {applied:false,reason:'stale_or_paused'};
  if (record.processedFingerprint===fingerprint) return {applied:false,reason:'already_processed'};
  record.processedFingerprint=fingerprint; record.pendingAt=null; record.lastProcessedAt=timestamp(now);
  if (!result || ['error','unconfigured'].includes(result.status)) {
    record.status='pending_information';
    notifyOnce(state,`model:${id}:${fingerprint}`,{type:'model_pending',conversationId:id,reason:result?.status || 'error',observedAt:timestamp(now)});
    return {applied:true};
  }
  // Keep model claims separate from confirmed facts and actually asked questions.
  record.modelSuggestion=structuredClone(result);
  record.draft=typeof result.draft==='string'?result.draft:null;
  record.summary=typeof result.summary==='string'?result.summary:null;
  record.suggestedFacts=structuredClone(result.facts || {});
  record.suggestedEvidence=structuredClone(result.evidence || []);
  record.suggestedQuestions=structuredClone(result.questions || []);
  record.status=result.action==='wait'?'waiting_reply':'draft_ready';
  if (result.action==='human_handoff') markHandoff(state,id,'model_requested_handoff',now);
  notifyOnce(state,`result:${id}:${fingerprint}`,{type:result.action==='summarize'?'candidate_summary':'draft_ready',conversationId:id,observedAt:timestamp(now)});
  return {applied:true};
}
