import {cleanFlow,analyzeDynamic,draftDynamicFlow} from './dynamic-flow.mjs';
import {loadWorkflowPolicy,planWorkflow} from './recruiting-workflow.mjs';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {syncPortfolioInvites,updatePortfolioCase} from './portfolio-cases.mjs';
import {analyzePortfolio} from './portfolio-workflow.mjs';
import {applySkillConfig} from './skill-config.mjs';
import {pathToFileURL} from 'node:url';
import {randomBytes} from 'node:crypto';
import {monitorRoot,readStatus,queueCommand} from './monitor-daemon.mjs';
import {isRecentRow} from './recent-conversations.mjs';
import {buildOperations,conversationRef} from './dashboard-metrics.mjs';
import {readDashboardSettings,saveAssessmentSettings,resolveSkillConfig} from './dashboard-settings.mjs';
import {handoffReviewAt} from './handoff-recovery.mjs';
import {buildAiAccessGuide} from './ai-access-guide.mjs';
import {describeNotification} from './notification-text.mjs';
import {readWorkflowSettings,saveWorkflowSettings} from './workflow-settings.mjs';
import {jobProfilesPath,readJobProfiles,saveJobProfiles} from './job-settings.mjs';
import {listAccounts,addAccount,updateAccount,launchAccount,prepareNewAccount,refreshAndSaveAccount} from './account-manager.mjs';
export function buildDashboardPayload(state,status){
  const expiry=state?.runtime?.capabilities?.assessmentExpiresAt;
  const expired=!!expiry&&Date.parse(expiry)<=Date.now()+60000;
  const recentConfig={recentWindowHours:state?.runtime?.recentWindowHours};
  const accountId=state?.runtime?.profile||'company-2';
  const operations=buildOperations(state,{accountId});
  const statsById=new Map(operations.conversations.map(c=>[c.id,c]));
  const conversations=Object.values(state?.conversations||{}).filter(c=>c.admitted!==false).map(c=>({
    ...statsById.get(c.id),recent:isRecentRow(c.row,recentConfig,Date.now(),c),
    id:c.id,conversationRef:conversationRef(accountId,c.id),name:c.name,jobTitle:c.jobTitle,status:c.status,humanHandoff:!!c.human_handoff,
    handoff:{...c.handoff,reason:c.handoff?.reason||c.handoffReason,autoReviewAt:c.human_handoff&&state.runtime?.handoffAutoResumeEnabled?handoffReviewAt(c,state.runtime):null},fingerprint:c.fingerprint,quietUntil:c.pendingAt?c.pendingAt+30000:null,
    clarificationCount:Number(c.clarificationCount)||0,lastMessage:(c.messages||[]).findLast(m=>['incoming','outgoing','unknown'].includes(m.direction))||null,
    messages:(c.messages||[]).slice(-15).map(m=>({direction:m.direction,text:m.text||m.displayText,observedTime:m.observedTime})),
    draft:c.draft||null,summary:c.summary||null,screening:c.screening||null,workflow:c.workflow||null,
    lastOutbound:c.lastOutbound||null,submission:c.submission?{materialsReceived:c.submission.materialsReceived,contentGraded:false,sender:c.submission.sender,attachments:c.submission.attachments.map(f=>({name:f.name,role:f.role,bytes:f.bytes}))}:null
  }));
  return {checkedAt:new Date().toISOString(),status,account:state?.account?{displayName:state.account.displayName}:null,conversations,
    metrics:operations.counts,metricDefinitions:operations.definitions,period:operations.period,
    platforms:[{id:'boss',name:'BOSS直聘',connected:!!status?.running&&status?.runtime?.health==='observing',accounts:[{id:accountId,name:state?.account?.displayName||accountId,metrics:operations.counts}]}],
    notifications:(state?.notifications||[]).filter(n=>!recentConfig.recentWindowHours||(!n.conversationId||conversations.some(c=>c.id===n.conversationId))).slice(-100).map(n=>describeNotification({key:n.key||`${n.type}:${n.conversationId}:${n.at||n.observedAt}:${n.reason}`,type:n.type,reason:n.reason,conversationId:n.conversationId,at:n.at||n.observedAt})),notificationCount:state?.notifications?.length||0,
    sentIntents:Object.values(state?.sentIntents||{}).slice(-50).map(i=>({id:i.id,conversationId:i.conversationId,status:i.status,messageId:i.messageId,workflowStage:i.workflowStage,receipt:i.receipt})),
    mailbox:state?.runtime?.mailbox||{status:'awaiting_configuration',message:'请填写技能配置中的 mailboxes，完成邮箱登录后才能确认收件。'},
    assessment:state?.runtime?.capabilities?.assessmentDelivery==='file'?{status:'file_configured',message:'同意后直接发送试题.xlsx，不需要下载链接。若该BOSS会话未提供文件上传入口，转人工处理；文件和回收说明均确认送达后才等待邮件。'}:{status:expired?'link_expired':state?.runtime?.capabilities?.assessmentLinkReady?'link_configured':'link_required',expiresAt:expiry||null,message:expired?'试题链接已过期或即将过期，已停止使用，请更新。':state?.runtime?.capabilities?.assessmentLinkReady?'已配置下载链接；候选人同意后才发送。'+(expiry?' 有效期至北京时间 '+new Date(expiry).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+'。':''):'请配置试题文件路径，或选择链接模式。'},
    coverage:recentConfig.recentWindowHours?`仅巡查最近 ${recentConfig.recentWindowHours} 小时有新消息的会话；旧会话无新回复不重复打开`:state?.runtime?.lastScan?`最近列表扫描 ${state.runtime.lastScan.scannedRows} 条；${state.runtime.lastScan.fullScan?'到达当前筛选末尾':'部分覆盖'}，不代表全部历史`:'当前已加载会话窗口；未证明全量历史覆盖',mode:state?.runtime?.mode||'observe_and_draft'};
}
export const dashboardHtml=await readFile(new URL('./web/dashboard.html',import.meta.url),'utf8');
const javascript=await readFile(new URL('./web/dashboard.js',import.meta.url),'utf8');
const portfolioHtml=await readFile(new URL('./web/portfolio.html',import.meta.url),'utf8');
const portfolioScript=await readFile(new URL('./web/portfolio.js',import.meta.url),'utf8');
export async function startMonitorWeb({port=19336,root=monitorRoot,monitorRoots={},monitorControl,settingsPath,jobProfilesFile=jobProfilesPath,verifyDownload}={}){
  const token=randomBytes(24).toString('hex');
  const server=createServer(async(req,res)=>{
    const origin=`http://127.0.0.1:${server.address().port}`;
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    const json=(code,data)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
    if(req.headers.host!==`127.0.0.1:${server.address().port}`||(req.headers.origin&&req.headers.origin!==origin))return json(403,{error:'LOCAL_ORIGIN_REQUIRED'});
    try {
      if(req.method==='GET'&&req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(dashboardHtml.replace('__CSRF_TOKEN__',token));return;}
      if(req.method==='GET'&&req.url==='/dashboard.js'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(javascript);return;}
      const requestUrl=new URL(req.url,origin);
      if(req.method==='GET'&&requestUrl.pathname==='/portfolio'){
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(portfolioHtml.replace('__CSRF_TOKEN__',token));return;
      }
      if(req.method==='GET'&&req.url==='/portfolio.js'){
        res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});res.end(portfolioScript);return;
      }
      if(['/api/flow/draft','/api/flow/preview'].includes(req.url)&&req.method==='POST'){
        if(req.headers['x-csrf-token']!==token||req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))return json(403,{error:'INVALID_REQUEST_ORIGIN'});
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>200000)return json(413,{error:'REQUEST_TOO_LARGE'});chunks.push(chunk);}
        try{
          const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const file=settingsPath||await resolveSkillConfig();
          const config=await applySkillConfig({model:{configFile:file}},dirname(file));
          if(req.url==='/api/flow/draft')return json(200,{flow:await draftDynamicFlow(config,input.requirements)});
          if(typeof input.sample!=='string'||!input.sample.trim()||input.sample.length>3000)return json(400,{error:'FLOW_SAMPLE_REQUIRED'});
          const job={id:'preview',status:'dynamic',name:String(input.name||'新岗位').slice(0,80),requirements:String(input.requirements||'').slice(0,6000),flow:cleanFlow(input.flow)};
          const conversation={messages:[{direction:'incoming',text:input.sample}],workflow:{stage:'screening'}};
          const analysis=await analyzeDynamic({config,conversation,job});
          const policy={...await loadWorkflowPolicy(),job};
          const plan=planWorkflow(conversation,analysis,policy,config);
          return json(200,{action:plan.type,reason:plan.reason||plan.screening?.reason,text:plan.text,evidence:plan.screening?.evidence});
        }catch(e){return json(e.code?.startsWith('MODEL_')?502:400,{error:e.code||'FLOW_REQUEST_FAILED'});}
      }
      const portfolioRoute=/^\/api\/portfolio\/([a-z0-9-]{1,64})$/.exec(req.url);
      if(portfolioRoute&&['GET','POST'].includes(req.method)){
        if(req.headers['x-csrf-token']!==token)return json(403,{error:'INVALID_REQUEST_ORIGIN'});
        const job=(await readJobProfiles(jobProfilesFile)).jobs.find(j=>j.id===portfolioRoute[1]&&j.status==='manual_portfolio');
        if(!job)return json(404,{error:'PORTFOLIO_JOB_REQUIRED'});
        const casesRoot=resolve(dirname(jobProfilesFile),'portfolio-cases');
        if(req.method==='GET')return json(200,{job:job.name,cases:await syncPortfolioInvites(casesRoot,job,monitorRoots)});
        if(req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))return json(403,{error:'INVALID_REQUEST_ORIGIN'});
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>100000)return json(413,{error:'REQUEST_TOO_LARGE'});chunks.push(chunk);}
        try{
          const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const analyze=async(job,sources)=>{
            const file=settingsPath||await resolveSkillConfig();
            const config=await applySkillConfig({model:{configFile:file}},dirname(file));
            return analyzePortfolio(config,job,sources);
          };
          return json(200,{record:await updatePortfolioCase(casesRoot,job,input,analyze)});
        }catch(e){return json(e.code==='PORTFOLIO_STATE_CHANGED'?409:400,{error:e.code||'PORTFOLIO_REQUEST_FAILED'});}
      }
      if(req.method==='GET'&&req.url==='/health')return json(200,{ok:true,app:'boss-recruiting-service',version:2});
      if(req.method==='GET'&&req.url==='/api/monitor-status'&&monitorControl)return json(200,{monitors:await monitorControl.status()});
      const monitorRoute=/^\/api\/monitors\/([a-z0-9][a-z0-9-]{1,48})$/.exec(req.url||'');
      if(monitorRoute&&req.method==='POST'&&monitorControl){
        if(req.headers['x-csrf-token']!==token||req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))return json(403,{error:'INVALID_REQUEST_ORIGIN'});
        let body='';for await(const chunk of req)body+=chunk;if(body.length>2000)return json(413,{error:'REQUEST_TOO_LARGE'});
        const input=JSON.parse(body);return json(200,{monitor:await monitorControl.set(monitorRoute[1],input.action)});
      }
      if(req.method==='GET'&&req.url==='/api/ai-guide')return json(200,buildAiAccessGuide());
      if(req.url==='/api/accounts'&&req.method==='GET'){
        if(req.headers['x-csrf-token']!==token)return json(403,{error:'INVALID_REQUEST_ORIGIN'});
        return json(200,{accounts:await listAccounts({refresh:true})});
      }
      if(req.url==='/api/accounts'&&req.method==='POST'){
        if(req.headers['x-csrf-token']!==token||req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))return json(403,{error:'INVALID_REQUEST_ORIGIN'});
        let body='';for await(const chunk of req)body+=chunk;if(body.length>5000)return json(413,{error:'REQUEST_TOO_LARGE'});return json(201,{account:await addAccount(JSON.parse(body))});
      }
      if(req.url==='/api/accounts/prepare'&&req.method==='POST'){
        if(req.headers['x-csrf-token']!==token||req.headers.origin!==origin)return json(403,{error:'INVALID_REQUEST_ORIGIN'});
        const result=await prepareNewAccount();
        return json(201,{account:result.account,loginRequired:true,endpoint:result.endpoint,message:result.message});
      }
      const accountUpdate=/^\/api\/accounts\/([a-z0-9][a-z0-9-]{1,48})$/.exec(req.url||'');
      if(accountUpdate&&req.method==='PATCH'){
        if(req.headers['x-csrf-token']!==token||req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))return json(403,{error:'INVALID_REQUEST_ORIGIN'});
        let body='';for await(const chunk of req)body+=chunk;if(body.length>3000)return json(413,{error:'REQUEST_TOO_LARGE'});return json(200,{account:await updateAccount(accountUpdate[1],JSON.parse(body))});
      }
      const accountRoute=/^\/api\/accounts\/([a-z0-9][a-z0-9-]{1,48})\/(login|refresh)$/.exec(req.url||'');
      if(accountRoute&&req.method==='POST'){
        if(req.headers['x-csrf-token']!==token||req.headers.origin!==origin)return json(403,{error:'INVALID_REQUEST_ORIGIN'});
        return json(200,accountRoute[2]==='login'?await launchAccount(accountRoute[1]):await refreshAndSaveAccount(accountRoute[1]));
      }
      if(req.url==='/api/workflow'&&['GET','POST'].includes(req.method)){
        if(req.headers['x-csrf-token']!==token)return json(403,{error:'INVALID_REQUEST_ORIGIN'});const path=settingsPath||await resolveSkillConfig();
        if(req.method==='GET')return json(200,await readWorkflowSettings(path));if(req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))return json(403,{error:'INVALID_REQUEST_ORIGIN'});
        let body='';for await(const chunk of req)body+=chunk;if(body.length>30000)return json(413,{error:'REQUEST_TOO_LARGE'});return json(200,await saveWorkflowSettings(path,JSON.parse(body)));
      }
      if(req.url==='/api/job-profiles'&&['GET','POST'].includes(req.method)){
        if(req.headers['x-csrf-token']!==token)return json(403,{error:'INVALID_REQUEST_ORIGIN'});
        if(req.method==='GET')return json(200,await readJobProfiles(jobProfilesFile));
        if(req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))return json(403,{error:'INVALID_REQUEST_ORIGIN'});
        const chunks=[];let size=0;
        for await(const chunk of req){size+=chunk.length;if(size>250000)return json(413,{error:'REQUEST_TOO_LARGE'});chunks.push(chunk);}
        try{return json(200,await saveJobProfiles(jobProfilesFile,JSON.parse(Buffer.concat(chunks).toString('utf8')),{verify:verifyDownload}));}
        catch(e){return json(e.code==='SETTINGS_CHANGED'?409:400,{error:e.code||'JOB_PROFILES_SAVE_FAILED'});}
      }
      if(req.method==='GET'&&new URL(req.url,origin).pathname==='/api/state'){
        const query=new URL(req.url,origin).searchParams,selectedRoot=monitorRoots[query.get('accountId')]||root;
        let state={};try{state=JSON.parse(await readFile(resolve(selectedRoot,'state.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
        return json(200,buildDashboardPayload(state,await readStatus(selectedRoot)));
      }
      if(req.url==='/api/settings'&&['GET','POST'].includes(req.method)){
        if(req.headers['x-csrf-token']!==token)return json(403,{error:'INVALID_REQUEST_ORIGIN'});
        const path=settingsPath||await resolveSkillConfig();
        if(req.method==='GET')return json(200,await readDashboardSettings(path));
        if(req.headers.origin!==origin||!req.headers['content-type']?.startsWith('application/json'))return json(403,{error:'INVALID_REQUEST_ORIGIN'});
        let chunks=[],size=0;for await(const chunk of req){size+=chunk.length;if(size>12000)return json(413,{error:'REQUEST_TOO_LARGE'});chunks.push(chunk);}
        let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{return json(400,{error:'INVALID_JSON'});}
        try{return json(200,await saveAssessmentSettings(path,input,verifyDownload?{verify:verifyDownload}:{}));}
        catch(e){return json(e.code==='SETTINGS_CHANGED'?409:400,{error:e.code||'SETTINGS_SAVE_FAILED'});}
      }
      if(req.method==='GET'&&/^\/api\/receipts\/[a-f0-9-]{36}$/.test(req.url)){
        try{return json(200,JSON.parse(await readFile(resolve(root,'receipts',req.url.split('/').at(-1)+'.json'),'utf8')));}catch(e){if(e.code==='ENOENT')return json(202,{queued:true});throw e;}
      }
      if(req.method==='POST'&&req.url==='/api/command'){
        if(req.headers.origin!==origin||req.headers['x-csrf-token']!==token||!req.headers['content-type']?.startsWith('application/json'))return json(403,{error:'INVALID_REQUEST_ORIGIN'});
        let body='',size=0;for await(const chunk of req){size+=chunk.length;if(size>12000)return json(413,{error:'REQUEST_TOO_LARGE'});body+=chunk;}
        const data=JSON.parse(body);
        const activeAccountId=String(root).split(/[\\/]/).at(-1);
        if((data.platformId&&data.platformId!=='boss')||(data.accountId&&data.accountId!==activeAccountId))return json(400,{error:'PLATFORM_NOT_CONNECTED'});
        if(!['pause','resume','takeover','resume-conversation','human-reply','retry-model','human-draft'].includes(data.command))return json(400,{error:'COMMAND_NOT_ALLOWED'});
        if(!['pause','resume'].includes(data.command)&&typeof data.conversationId!=='string')return json(400,{error:'CONVERSATION_REQUIRED'});
        const commandRoot=monitorRoots[data.accountId]||root;
        const id=await queueCommand(data.command,data.conversationId,commandRoot,{text:data.text,fingerprint:data.fingerprint,hasDraft:data.hasDraft});
        return json(202,{queued:true,id,message:'已进入控制队列；不等于已发送，发送结果以会话回执为准。'});
      }
      return json(404,{error:'NOT_FOUND'});
    }catch(e){return json(e.code==='MONITOR_OFFLINE'?409:500,{error:e.code||'REQUEST_FAILED'});}
  });
  server.requestTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  console.log(`Recruiting dashboard: http://127.0.0.1:${server.address().port}/`);return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)startMonitorWeb().catch(e=>{console.error(JSON.stringify({error:e.code||'WEB_FAILED'}));process.exitCode=1;});
