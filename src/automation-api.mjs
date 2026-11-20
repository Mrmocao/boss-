import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash,timingSafeEqual,randomUUID} from 'node:crypto';
import {buildOperations} from './dashboard-metrics.mjs';
import {handoffReviewAt} from './handoff-recovery.mjs';
import {projectRoot} from './config.mjs';
import {monitorRoot as defaultMonitorRoot} from './monitor-daemon.mjs';

export const apiConfigPath=resolve(projectRoot,'.local/automation-api.json');
const digest=value=>createHash('sha256').update(value).digest('hex');
const timestamp=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const code=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(value)?value:null;
const label=(value,allowed,fallback='unknown')=>allowed.includes(value)?value:fallback;
async function readJson(path,missing){try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return missing;throw e;}}
export async function readAutomationConfig(path=apiConfigPath){
 const config=await readJson(path,null);
 if(!config||typeof config.enabled!=='boolean'||config.host!=='127.0.0.1'||!Number.isInteger(config.port)||config.port<1024||config.port>65535
  ||typeof config.token!=='string'||!/^[A-Za-z0-9_-]{43,128}$/.test(config.token))throw Object.assign(Error('Invalid automation API config'),{code:'AUTOMATION_CONFIG_INVALID'});
 return config;
}
const pidAlive=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch{return false;}};
function processHealth(state,owner,now,threshold){
 const runtime=state?.runtime||{},heartbeat=timestamp(runtime.heartbeatAt),age=heartbeat?now-Date.parse(heartbeat):null;
 const running=!!owner&&runtime.pid===owner.pid&&pidAlive(owner.pid);
 const started=timestamp(runtime.startedAt);
 return {running,responsive:running&&age!==null&&age>=0&&age<threshold&&(!started||Date.parse(heartbeat)>=Date.parse(started)),heartbeatAt:heartbeat,heartbeatAgeMs:age,startedAt:started};
}
export async function loadAutomationState({monitorRoot=defaultMonitorRoot,serviceRoot=resolve(projectRoot,'.local/service'),now=Date.now()}={}){
 const [state,monitorOwner,service,serviceOwner]=await Promise.all([
  readJson(resolve(monitorRoot,'state.json'),null),readJson(resolve(monitorRoot,'daemon.lock/owner.json'),null),
  readJson(resolve(serviceRoot,'state.json'),null),readJson(resolve(serviceRoot,'daemon.lock/owner.json'),null)
 ]);
 if(state&&(!state.runtime||!state.conversations||Array.isArray(state.conversations)))throw Error('INVALID_STATE');
 return {state:state||{},monitor:processHealth(state,monitorOwner,now,90000),supervisor:processHealth(service,serviceOwner,now,20000)};
}
export function handoffCategory(c){
 const reason=c.handoffReason||c.handoff?.reason||'';
 if(c.handoff?.autoResumeBlocked||/SEND_|发送结果|回执|send_unknown/.test(reason))return 'delivery_verification';
 if(/身份|账号|IDENTITY|ACCOUNT|discontinuity/.test(reason))return 'identity_or_history';
 if(/薪资|政策|奖金/.test(reason))return 'policy_question';
 if(/专业|学历|教育|硬条件|补问/.test(reason))return 'qualification_review';
 if(/FILE_|附件|试题|链接/.test(reason))return 'assessment_or_attachment';
 if(/MODEL_/.test(reason))return 'model_error';
 if(/explicit_manual|human_activity/.test(reason))return 'manual_takeover';
 return 'needs_review';
}
/** Allowlisted machine schema: never serialize state, credentials, free-text notes or candidate messages. */
export function buildAutomationSnapshot({state={},monitor,supervisor},now=Date.now()){
 const runtime=state.runtime||{},accountId=typeof runtime.profile==='string'&&/^[a-z0-9-]{1,50}$/.test(runtime.profile)?runtime.profile:'company-2';
 const observed=timestamp(runtime.lastObservationAt),observationAge=observed?now-Date.parse(observed):null;
 const observationFresh=!!monitor?.responsive&&observationAge!==null&&observationAge>=0&&observationAge<90000
  &&(!monitor.startedAt||Date.parse(observed)>=Date.parse(monitor.startedAt));
 const health=label(runtime.health,['observing','paused','starting','stopped','waiting_stable_page','disconnected']);
 const connected=observationFresh&&health==='observing';
 const operations=buildOperations(state,{accountId,now});
 const scope={platformId:'boss',accountId};
 const stageValues=['screening','waiting_reply','waiting_consent','waiting_clarification','test_pending','waiting_email','submission_incomplete','awaiting_review','assessment_file_sent','rejected_screening','declined_test','lost','do_not_contact'];
 const rows=Object.values(state.conversations||{}).filter(c=>c.admitted!==false).map(c=>{
  const ref=digest(`boss|${accountId}|${c.id}`).slice(0,32);
  const last=(c.messages||[]).findLast(m=>['incoming','outgoing','unknown'].includes(m.direction));
  return {...scope,conversationRef:ref,stage:label(c.workflow?.stage||c.status,stageValues),status:label(c.status,[...stageValues,'human_review','chatting','pending_information','draft_ready','blocked_config','stopped']),
    humanHandoff:!!c.human_handoff,category:c.human_handoff?handoffCategory(c):null,
    lastMessageDirection:last?.direction||null,admittedAt:timestamp(c.admittedAt),
    lastActivityAt:timestamp(c.lastManualReplyAt)||timestamp(c.lastOutbound?.receipt?.observedAt),
    clarificationCount:Number.isInteger(c.clarificationCount)?c.clarificationCount:0,
    openedAt:timestamp(c.handoff?.openedAt),lastHumanReplyAt:timestamp(c.handoff?.lastRepliedAt),
    autoReviewAt:c.human_handoff&&runtime.handoffAutoResumeEnabled?handoffReviewAt(c,runtime):null,
    autoResumeBlocked:!!c.handoff?.autoResumeBlocked,draftPresent:!!c.handoff?.draftPresent,replyQueued:!!c.humanReply,
    reviewStatus:label(c.handoff?.reviewStatus,['checking','deferred','needs_human','waiting_peer','waiting_quiet','auto_resumed'],null),
    materialsReceived:!!c.submission?.materialsReceived};
 }).sort((a,b)=>a.conversationRef.localeCompare(b.conversationRef));
 const expiry=timestamp(runtime.capabilities?.assessmentExpiresAt),expired=!!expiry&&Date.parse(expiry)<=now+60000;
 const mailbox=runtime.mailbox||{},mailChecked=timestamp(mailbox.checkedAt),mailAge=mailChecked?now-Date.parse(mailChecked):null;
 const accounts=(mailbox.accounts||[]).map(a=>({mailboxRef:digest(String(a.id)).slice(0,16),status:label(a.status,['connected','disabled','error']),hasError:!!a.error}));
 const stats={};for(const [key,value] of Object.entries(operations.counts))stats[key]=Number.isFinite(value)?value:0;
 const sends={confirmed:0,unknown:0,inProgress:0,notSent:0};for(const i of Object.values(state.sentIntents||{})){
  if(i.status==='sent_confirmed')sends.confirmed++;else if(i.status==='send_unknown')sends.unknown++;else if(['prepared','send_attempt_started'].includes(i.status))sends.inProgress++;else if(i.status==='not_sent')sends.notSent++;
 }
 const result={
  service:{apiAvailable:true,supervisor,monitor:{...monitor,health:monitor.running?health:'stopped',reportedHealth:health,paused:!!state.controls?.paused,lastErrorCode:code(runtime.lastError)},
    mode:label(runtime.mode,['automatic','observe_and_draft']),automaticSendConfigured:runtime.sendEnabled===true,
    automaticProcessingActive:connected&&!state.controls?.paused&&runtime.sendEnabled===true,
    lastObservationAt:observed,observationAgeMs:observationAge,observationFresh},
  integrations:{platforms:[{id:'boss',name:'BOSS直聘',adapterImplemented:true,accounts:[{id:accountId,connected,lastVerifiedObservationAt:observed,identityConfidence:'display_only',health:connected?'connected':monitor.running?'unavailable':'offline'}]}],
    model:{enabled:!!runtime.modelEnabled,configurationReady:!!runtime.modelReady,connectivity:'not_probed_by_api'},
    assessment:{delivery:label(runtime.capabilities?.assessmentDelivery,['file','link']),status:runtime.capabilities?.assessmentDelivery==='file'?'file_configured':expired?'link_expired':runtime.capabilities?.assessmentLinkReady?'link_configured':'not_configured',expiresAt:expiry},
    mailbox:{status:label(mailbox.status,['connected','awaiting_configuration','read_error']),checkedAt:mailChecked,stale:mailAge===null||mailAge<0||mailAge>180000,accounts},
    outboundEmail:{status:'not_probed_by_api'},notifications:{channels:['local_dashboard','browser_when_open'],dingTalkConnected:false}},
  statistics:{...scope,timeZone:'Asia/Shanghai',today:operations.period.today,yesterday:operations.period.yesterday,counts:stats,sendReceipts:sends,
    definitions:operations.definitions,scope:'current_active_records_and_retained_archive_counts; not a complete platform history'},
  humanIntervention:{total:rows.filter(c=>c.humanHandoff).length,configurationBlocked:rows.filter(c=>c.status==='blocked_config').length,
    categories:rows.filter(c=>c.humanHandoff).reduce((a,c)=>(a[c.category]=(a[c.category]||0)+1,a),{}),
    items:rows.filter(c=>c.humanHandoff||c.status==='blocked_config')},
  conversations:rows,
  coverage:{recentWindowHours:runtime.recentWindowHours||null,retentionDays:3,lastScanAt:timestamp(runtime.lastScan?.checkedAt),
    scannedRows:Number.isFinite(runtime.lastScan?.scannedRows)?runtime.lastScan.scannedRows:null,
    scanStopReason:label(runtime.lastScan?.scanStopReason,['explicit_end','recent_window_end','loaded_end_unconfirmed','step_limit','row_limit','scroll_stalled'],null),
    fullHistoryVerified:false,messageIdsVerified:false},
  capabilities:{readOnly:true,mutationSupported:false,platforms:['boss'],candidateNamesIncluded:false,messageBodiesIncluded:false,credentialsIncluded:false}
 };
 return result;
}

export async function startAutomationApi({configPath=apiConfigPath,monitorRoot,serviceRoot,loadState=loadAutomationState,now=Date.now}={}){
 const startup=await readAutomationConfig(configPath);if(!startup.enabled)return null;
 let recentRequests=[];
 const server=createServer(async(req,res)=>{
  const requestId=randomUUID();res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Request-Id',requestId);
  const json=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  const error=(status,code)=>json(status,{apiVersion:'v1',requestId,error:{code}});
  try{
   // Dedicated listener intentionally has no browser UI, configuration or mutation routes.
   let config;try{config=await readAutomationConfig(configPath);}catch{return error(503,'API_CONFIGURATION_UNAVAILABLE');}
   if(!config.enabled)return error(503,'API_DISABLED');
   const credential=req.headers.authorization;
   const supplied=typeof credential==='string'&&credential.startsWith('Bearer ')?credential.slice(7):'';
   if(!supplied||!timingSafeEqual(Buffer.from(digest(supplied),'hex'),Buffer.from(digest(config.token),'hex'))){res.setHeader('WWW-Authenticate','Bearer');return error(401,'UNAUTHORIZED');}
   if(req.headers.origin)return error(403,'BROWSER_ORIGIN_NOT_ALLOWED');
   if(req.method!=='GET'){res.setHeader('Allow','GET');return error(405,'READ_ONLY_API');}
   const moment=now();recentRequests=recentRequests.filter(t=>moment-t<60000);if(recentRequests.length>=120){res.setHeader('Retry-After','60');return error(429,'RATE_LIMITED');}recentRequests.push(moment);
   const url=new URL(req.url,'http://127.0.0.1');
   const endpoints=new Set(['/api/v1/snapshot','/api/v1/health','/api/v1/integrations','/api/v1/statistics','/api/v1/handoffs','/api/v1/conversations']);
   if(url.pathname==='/api/v1/openapi.json')return json(200,JSON.parse(await readFile(new URL('../docs/automation-api.openapi.json',import.meta.url),'utf8')));
   if(!endpoints.has(url.pathname))return error(404,'NOT_FOUND');
   const paged=['/api/v1/handoffs','/api/v1/conversations'].includes(url.pathname);
   if([...url.searchParams.keys()].some(k=>!paged||!['limit','cursor'].includes(k)))return error(400,'INVALID_QUERY');
   const limitText=url.searchParams.get('limit')||'50';if(!/^\d+$/.test(limitText)||Number(limitText)<1||Number(limitText)>100)return error(400,'INVALID_LIMIT');
   let loaded;try{loaded=await loadState({monitorRoot,serviceRoot,now:moment});}catch{return error(503,'STATE_UNAVAILABLE');}
   const snapshot=buildAutomationSnapshot(loaded,moment);
   const revision=digest(JSON.stringify({...snapshot,service:{...snapshot.service,monitor:{...snapshot.service.monitor,heartbeatAgeMs:null},supervisor:{...snapshot.service.supervisor,heartbeatAgeMs:null},observationAgeMs:null}}));
   let data;
   switch(url.pathname){
    case '/api/v1/snapshot':data={...snapshot};delete data.conversations;data.humanIntervention={...snapshot.humanIntervention};delete data.humanIntervention.items;break;
    case '/api/v1/health':data=snapshot.service;break;
    case '/api/v1/integrations':data=snapshot.integrations;break;
    case '/api/v1/statistics':data=snapshot.statistics;break;
    default:{
     const list=url.pathname.endsWith('/handoffs')?snapshot.humanIntervention.items:snapshot.conversations;
     const listRevision=digest(JSON.stringify(list));let offset=0;
     if(url.searchParams.has('cursor')){
      let cursor;try{const raw=url.searchParams.get('cursor');if(raw.length>1024)throw Error();cursor=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'));}catch{return error(400,'INVALID_CURSOR');}
      if(cursor.path!==url.pathname||!Number.isSafeInteger(cursor.offset)||cursor.offset<0||cursor.offset>list.length)return error(400,'INVALID_CURSOR');
      if(cursor.revision!==listRevision)return error(409,'SNAPSHOT_CHANGED');offset=cursor.offset;
     }
     const limit=Number(limitText),next=offset+limit;
     data={items:list.slice(offset,next),total:list.length,listRevision,nextCursor:next<list.length?Buffer.from(JSON.stringify({path:url.pathname,offset:next,revision:listRevision})).toString('base64url'):null};
    }
   }
   const etag='"'+digest(JSON.stringify({path:url.pathname,revision,data}))+'"';res.setHeader('ETag',etag);
   if(req.headers['if-none-match']===etag){res.writeHead(304);res.end();return;}
   return json(200,{apiVersion:'v1',requestId,generatedAt:new Date(moment).toISOString(),snapshotRevision:revision,
    freshness:{stateAvailable:!!loaded.state?.runtime,stale:!snapshot.service.observationFresh,lastObservationAt:snapshot.service.lastObservationAt},data});
  }catch{return error(500,'INTERNAL_ERROR');}
 });
 server.requestTimeout=10000;server.headersTimeout=10000;
 await new Promise((done,reject)=>{server.once('error',reject);server.listen(startup.port,startup.host,done);});
 return server;
}
