import {activityWindow} from './recent-conversations.mjs';

export const RETENTION_MS=3*86400000;
const parse=value=>typeof value==='number'?value:Date.parse(value)||0;
const terminalReasons={rejected_screening:'not_qualified',declined_test:'declined',do_not_contact:'declined',lost:'inactive'};

export function lastEffectiveActivity(c){
 // Resolve relative labels at observation time, not every day at current wall time.
 const at=parse(c.lastObservedAt)||parse(c.firstObservedAt)||parse(c.admittedAt);
 const label=at?activityWindow(c.row?.displayTime,at):null;
 return Math.max(label?.end||0,parse(c.lastLiveChangeAt),parse(c.lastOutbound?.receipt?.observedAt),parse(c.lastManualReplyAt));
}
export function archiveInactiveConversations(state,config,now=Date.now()){
 if(config.retentionDays!==3)return {archived:0};
 state.archivedConversations??={};let archived=0;
 for(const [id,c] of Object.entries(state.conversations)){
  const stage=c.workflow?.stage||c.status;
  const pending=Object.values(state.sentIntents||{}).some(i=>i.conversationId===id&&['prepared','send_attempt_started','send_unknown'].includes(i.status));
  // Do not hide an unfinished/unknown send while it still needs reconciliation.
  if(pending||c.humanReply||c.handoff?.draftPresent)continue;
  const last=lastEffectiveActivity(c),reason=terminalReasons[stage]||(last&&now-last>RETENTION_MS?'inactive':null);
  if(!reason)continue;
  state.archivedConversations[id]={id,reason,archivedAt:new Date(now).toISOString(),lastActivityAt:last?new Date(last).toISOString():null,
    admitted:c.admitted!==false,admittedAt:c.admittedAt||null,platform:'boss',profile:config.profile||'company-2'};
  delete state.conversations[id];archived++;
 }
 if(archived){
  state.notifications=state.notifications.filter(n=>!n.conversationId||!state.archivedConversations[n.conversationId]);
  state.events.push({type:'conversations_archived',count:archived,at:new Date(now).toISOString()});
 }
 return {archived};
}
