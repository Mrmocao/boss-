import {createHash} from 'node:crypto';
export const conversationRef=(accountId,id)=>createHash('sha256').update(['boss',accountId,id].join('|')).digest('hex').slice(0,32);
const day=ms=>new Date(ms+8*3600000).toISOString().slice(0,10);
const valid=v=>typeof v==='string'&&Number.isFinite(Date.parse(v));
const terminal=new Set(['rejected_screening','declined_test','lost','do_not_contact','stopped']);
export function buildOperations(state,{platformId='boss',platformName='BOSS直聘',accountId='company-2',now=Date.now()}={}){
 const records=Object.values(state?.conversations||{}).filter(c=>c.admitted!==false);
 const today=day(now),yesterday=day(now-86400000);
 const intents=Object.values(state?.sentIntents||{}).filter(i=>i.status==='sent_confirmed');
 const conversationKeys=new Set(records.map(c=>c.id));
 const archived=Object.values(state?.archivedConversations||{}).filter(c=>c.admitted!==false);
 const counts={todayNew:0,yesterdayNew:0,communicating:0,pendingReply:0,humanReview:0,awaitingReview:0,waitingEmail:0,total:records.length,unknownStart:0,todaySent:0,
  archivedTotal:archived.length,archivedInactive:archived.filter(c=>c.reason==='inactive').length,archivedDeclined:archived.filter(c=>c.reason==='declined').length,archivedNotQualified:archived.filter(c=>c.reason==='not_qualified').length};
 const conversations=records.map(c=>{
  const stage=c.workflow?.stage||c.status;
  const last=(c.messages||[]).findLast(m=>['incoming','outgoing','unknown'].includes(m.direction));
  const start=c.admittedAt;
  if(valid(start)){if(day(Date.parse(start))===today)counts.todayNew++;if(day(Date.parse(start))===yesterday)counts.yesterdayNew++;}else counts.unknownStart++;
  const active=!terminal.has(stage)&&stage!=='awaiting_review';
  if(active)counts.communicating++;
  if(active&&!c.human_handoff&&last?.direction==='incoming'&&!['waiting_email','submission_incomplete'].includes(stage))counts.pendingReply++;
  if(c.human_handoff||c.status==='blocked_config')counts.humanReview++;
  if(stage==='awaiting_review')counts.awaitingReview++;
  if(['waiting_email','submission_incomplete'].includes(stage))counts.waitingEmail++;
  const summary=[c.handoffReason?`待处理：${c.handoffReason}`:null,c.analysis?.intent?.value==='yes'?'已表达策划意向':null,
    c.detail?.candidate?.educationText?.[0],c.lastOutbound?.receipt?.status?`最近发送${c.lastOutbound.receipt.status}`:null].filter(Boolean).join('；');
  return {id:c.id,key:[platformId,accountId,c.id].map(encodeURIComponent).join('/'),platformId,platformName,accountId,
    accountName:state.account?.displayName||accountId,admittedAt:valid(start)?start:null,lastActivityAt:c.lastLiveChangeAt?new Date(c.lastLiveChangeAt).toISOString():c.lastInboundObservedAt?new Date(c.lastInboundObservedAt).toISOString():c.lastOutbound?.receipt?.observedAt||null,
    summaryPreview:summary||'尚无已核验的详情摘要',summaryBasis:'已观察资料与流程记录',messageCount:(c.messages||[]).length,active};
 });
 for(const i of intents)if(conversationKeys.has(i.conversationId)&&valid(i.receipt?.observedAt)&&day(Date.parse(i.receipt.observedAt))===today)counts.todaySent++;
 return {platformId,platformName,accountId,counts,conversations,period:{today,yesterday,timeZone:'Asia/Shanghai'},definitions:{new:'系统首次纳入沟通日期；不是平台投递人数',communicating:'已纳入且未结束的会话，包含等待回复/收件与人工处理',unknownStart:'历史记录未记录纳入时间，不追溯猜测',scope:'只统计本机实际记录，覆盖范围受平台列表加载限制'}};
}
