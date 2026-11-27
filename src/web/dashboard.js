'use strict';
const $=id=>document.getElementById(id),token=document.querySelector('meta[name="csrf"]').content;
const labels={observing:'正在运行',stopped:'已停止',paused:'已暂停',disconnected:'页面未连接',waiting_stable_page:'等待页面稳定',waiting_reply:'等待回复',waiting_consent:'等待问卷意愿',screening:'核验资料',pending_information:'待核实资料',waiting_clarification:'等待补充资料',test_pending:'等待发题配置',waiting_email:'等待交卷',submission_incomplete:'材料未齐',awaiting_review:'待批改',human_review:'人工处理中',chatting:'合并消息中',draft_ready:'草稿待查看',blocked_config:'配置待补齐',rejected_screening:'已婉拒',declined_test:'已拒绝问卷',awaiting_configuration:'等待邮箱配置',disabled:'未启用',connected:'连接正常',error:'连接或配置异常'};
const monitorErrors={CDP_UNAVAILABLE:'专用浏览器未连接',CDP_TIMEOUT:'浏览器响应超时',NO_VERIFIED_RECRUITER_TARGET:'未找到已验证的招聘沟通页',NO_VERIFIED_RECRUITER_PAGE:'未找到招聘沟通页',ACCOUNT_CHANGED:'账号身份发生变化',ACCOUNT_UNVERIFIED:'账号页面未完成验证',LOGIN_SUSPECTED:'需要重新登录',PAGE_CHANGED:'页面已离开沟通页',BROWSER_RECOVERY_FAILED:'浏览器自动恢复失败'};
const text=(tag,value='',cls)=>{const e=document.createElement(tag);e.textContent=value??'—';if(cls)e.className=cls;return e;};
const fmt=v=>v?new Date(v).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'—';
const truncate=(v,n=95)=>String(v||'').length>n?String(v).slice(0,n)+'…':String(v||'');
let data,lastSelection=null,page=0,seen=new Set(),initialized=false,notify=false,settingsRevision=null,savedRevision=null,workflowRevision=null,dirty=false,pageName='overview',editingAccountId=null,jobsRevision=null,jobs=[],selectedJobId=null;
const drafts=new Map(),PAGE_SIZE=12;
const draftReports=new Map();
async function reportDraft(c,hasDraft){
 const r=await fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify({command:'human-draft',platformId:c.platformId,accountId:c.accountId,conversationId:c.id,hasDraft})});
 const result=await r.json();if(!r.ok)throw Error(errors[result.error]||result.error);return result;
}
function draftInput(c,value){drafts.set(c.key,value);const previous=draftReports.get(c.key);const hasDraft=!!value.trim();
 if(!previous||previous.hasDraft!==hasDraft||Date.now()-previous.at>15000){draftReports.set(c.key,{hasDraft,at:Date.now()});reportDraft(c,hasDraft).catch(e=>banner('草稿保护同步失败：'+e.message+'；请暂停自动处理后编辑。'));}}
const errors={INVALID_JOB_PROFILE:'请检查岗位名称和各项要求。',INVALID_JOB_EDUCATION_OR_TITLE:'请填写职位名称，并从本科、硕士、博士、大专、专科、高中选择学历。',CONFLICTING_MAJORS:'同一专业同时出现在接受和排除范围。',JOB_TITLE_IN_USE:'该 BOSS 职位名称已绑定其他岗位。',SETTINGS_CHANGED:'配置已被其他窗口修改，请重新读取后保存。',INVALID_OR_EXPIRED_ASSESSMENT_URL:'请输入有效的公司 HTTPS Excel 链接，链接可能已过期。',ASSESSMENT_LINK_UNREACHABLE:'链接无法下载，请检查地址是否完整。',ASSESSMENT_DOWNLOAD_INVALID:'链接返回的不是有效的 Excel 下载内容。',INVALID_REQUEST_ORIGIN:'页面会话已更新，请刷新页面后重试。'};
function banner(v){$('banner').textContent=v;$('banner').classList.add('visible');}
function showPage(name){pageName=name;for(const e of document.querySelectorAll('.page'))e.hidden=e.id!==name;for(const e of document.querySelectorAll('.nav')){e.classList.toggle('active',e.dataset.page===name);if(e.dataset.page===name)e.setAttribute('aria-current','page');else e.removeAttribute('aria-current');}$('page-title').textContent={overview:'概览与沟通',accounts:'账号管理',handoff:'人工待办',settings:'设置与问卷','ai-access':'AI 接入说明'}[name];if(name==='settings'){if(settingsRevision===null)loadSettings();if(workflowRevision===null)loadWorkflow();if(jobsRevision===null)loadJobs();}if(name==='accounts')loadAccounts();if(name==='handoff'&&data)renderHandoffs();if(name==='ai-access'&&!aiGuide)loadAiGuide();if(location.hash!=='#'+name)history.replaceState(null,'','#'+name);}
for(const e of document.querySelectorAll('.nav'))e.onclick=()=>showPage(e.dataset.page);$('open-settings').onclick=()=>showPage('settings');
async function command(command,c,payload={}){
 const response=await fetch('/api/command',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify({command,platformId:c?.platformId,accountId:c?.accountId,conversationId:c?.id,...payload})});const result=await response.json();if(!response.ok)throw Error(errors[result.error]||result.error);banner('操作已排队，等待服务确认…');
 for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,1000));const r=await fetch('/api/receipts/'+result.id);const receipt=await r.json();if(r.status===200){banner(receipt.ok?'服务已接收操作；实际发送结果请查看会话回执。':'操作未完成：'+receipt.code);return;}}banner('请求仍在队列中，请稍后查看状态。');
}
function action(label,fn,primary=false){const b=text('button',label,'button'+(primary?' primary':''));b.onclick=async()=>{b.disabled=true;b.setAttribute('aria-busy','true');try{await fn();}catch(e){banner(e.message);}finally{b.disabled=false;b.removeAttribute('aria-busy');}};return b;}
function options(id,items,placeholder){const e=$(id),previous=e.value;const desired=JSON.stringify(items);if(e.dataset.items===desired)return;e.replaceChildren(new Option(placeholder,''),...items.map(i=>new Option(i.name,i.id)));e.value=previous;e.dataset.items=desired;}
function filtered(){const q=$('search').value.trim().toLowerCase(),stage=$('stage-filter').value;return (data?.conversations||[]).filter(c=>{
 if($('platform-filter').value&&c.platformId!==$('platform-filter').value)return false;if($('account-filter').value&&c.accountId!==$('account-filter').value)return false;
 if(q&&!`${c.name} ${c.jobTitle} ${c.summaryPreview} ${c.lastMessage?.text||''}`.toLowerCase().includes(q))return false;
 if(stage==='today'||stage==='yesterday'){const date=Date.parse(c.admittedAt);return Number.isFinite(date)&&new Date(date+8*3600000).toISOString().slice(0,10)===data.period[stage];}
 if(stage==='active')return c.active;if(stage==='recent')return c.recent;if(stage==='human')return c.humanHandoff||c.status==='blocked_config';if(stage==='reply')return c.active&&!c.humanHandoff&&c.lastMessage?.direction==='incoming'&&!['waiting_email','submission_incomplete'].includes(c.workflow?.stage);return !stage||c.workflow?.stage===stage;
 }).sort((a,b)=>(Date.parse(b.lastActivityAt)||0)-(Date.parse(a.lastActivityAt)||0));}
function renderList(){if(!data)return;const list=filtered();page=Math.min(page,Math.max(0,Math.ceil(list.length/PAGE_SIZE)-1));if(!list.some(c=>c.key===lastSelection))lastSelection=list[0]?.key||null;
 const tbody=$('conversations');tbody.replaceChildren();for(const c of list.slice(page*PAGE_SIZE,(page+1)*PAGE_SIZE)){
  const tr=document.createElement('tr');tr.classList.toggle('selected',c.key===lastSelection);tr.setAttribute('aria-selected',c.key===lastSelection?'true':'false');tr.tabIndex=0;const choose=()=>{lastSelection=c.key;renderList();};tr.onclick=choose;tr.onkeydown=e=>{if(e.key==='Enter')choose();};
 const who=document.createElement('td');who.append(text('strong',c.name),text('span',c.jobTitle,'sub'));
 const source=document.createElement('td');source.append(text('strong',c.platformName),text('span',c.accountName,'sub'));
 const state=document.createElement('td');state.append(text('span',labels[c.humanHandoff?'human_review':c.status==='blocked_config'?c.status:c.workflow?.stage||c.status]||c.status,'badge'+(c.humanHandoff?' warn':'')));
 if(c.quietUntil>Date.now())state.append(text('p',Math.ceil((c.quietUntil-Date.now())/1000)+' 秒后处理','sub'));
 const preview=document.createElement('td');preview.append(text('div',truncate(c.lastMessage?.text||c.summaryPreview),'preview'),text('div',c.lastActivityAt?fmt(c.lastActivityAt):'活动时间未记录','sub'));tr.append(who,source,state,preview);tbody.append(tr);
 }if(!list.length){const tr=document.createElement('tr'),td=text('td','当前筛选下暂无会话','empty');td.colSpan=4;tr.append(td);tbody.append(tr);}
 $('total-label').textContent='已纳入 '+data.metrics.total+' 个会话';$('page-count').textContent=`筛选 ${list.length} 条 · 第 ${page+1} / ${Math.max(1,Math.ceil(list.length/PAGE_SIZE))} 页`;$('previous').disabled=page===0;$('next').disabled=(page+1)*PAGE_SIZE>=list.length;renderDetail(list.find(c=>c.key===lastSelection));
}
let detailKey=null,detailVersion=null;
function renderDetail(c){const e=$('detail');const version=c?JSON.stringify([c.key,c.messages,c.summaryPreview,c.lastOutbound,c.draft,c.submission,c.humanHandoff]):null;if(c&&version===detailVersion)return;const prior=e.querySelector('.history'),scroll=prior?.scrollTop||0,same=c?.key===detailKey;detailKey=c?.key||null;detailVersion=version;e.replaceChildren();if(!c){e.append(text('p','选择一条会话，查看沟通摘要和最近消息。','empty'));return;}
 e.append(text('h3',c.name+' · '+c.jobTitle),text('p',c.platformName+' / '+c.accountName,'sub'),text('div',c.summaryPreview,'summary-box'),text('p','摘要来自已观察资料与流程记录，不代表完整简历或完整历史。','sub'));
 const history=text('div','','history');for(const m of c.messages||[]){const bubble=text('div','','bubble '+m.direction);bubble.append(text('small',(m.direction==='incoming'?'候选人':m.direction==='outgoing'?'招聘方':'平台提示')+(m.observedTime?' · '+m.observedTime:'')),text('span',m.text||'非文本内容'));history.append(bubble);}if(!c.messages?.length)history.append(text('p','暂未读取对话详情','empty'));e.append(history);history.scrollTop=same?scroll:history.scrollHeight;
 if(c.lastOutbound)e.append(text('p','最近发送：'+(c.lastOutbound.receipt?.status||'未确认')+' · '+fmt(c.lastOutbound.receipt?.observedAt),'sub'));if(c.draft)e.append(text('h3','本地草稿'),text('p',c.draft,'text'));
 if(c.submission)e.append(text('p','收件：'+c.submission.attachments.map(f=>f.name).join('、'),'text'));
 e.append(action(c.humanHandoff?'打开人工处理区':'人工接管',()=>c.humanHandoff?showPage('handoff'):command('takeover',c)));
}
function renderHandoffs(){const e=$('handoffs');if(e.contains(document.activeElement)&&document.activeElement?.tagName==='TEXTAREA')return;e.replaceChildren();const candidates=data.conversations.filter(c=>c.humanHandoff);if(!candidates.length){e.append(text('p','暂无需要人工回复的会话','empty'));return;}
 for(const c of candidates){const box=text('div','','handoff');box.append(text('h3',`${c.name} · ${c.jobTitle}`),text('p',c.handoff?.reason||'需人工核实','text'));
 const review=c.handoff?.autoResumeBlocked?'发送或身份待核验，不能因超时恢复':c.handoff?.draftPresent?'有人工草稿，暂不自动接管':c.handoff?.replyQueued?'人工回复已排队':c.handoff?.autoReviewAt?'10分钟未回复后自动回检 · '+fmt(c.handoff.autoReviewAt):'等待符合规则的上下文';box.append(text('p',review,'sub'));if(c.handoff?.reviewReason)box.append(text('p','最近回检：'+c.handoff.reviewReason,'sub'));
 const history=document.createElement('details');history.append(text('summary','查看最近消息'));for(const m of c.messages||[])history.append(text('p',(m.direction==='incoming'?'候选人：':'招聘方：')+(m.text||''),'text'));box.append(history);const input=document.createElement('textarea');input.maxLength=1500;input.placeholder='输入核实后的回复';input.value=drafts.get(c.key)||'';input.oninput=()=>draftInput(c,input.value);box.append(input);const actions=text('div','','bar');actions.append(action(c.handoff?.replyQueued?'回复已排队':'发送人工回复',async()=>{if(!input.value.trim())throw Error('请填写回复');await command('human-reply',c,{text:input.value.trim(),fingerprint:c.fingerprint});drafts.delete(c.key);},true),action('清除草稿',async()=>{input.value='';drafts.delete(c.key);await reportDraft(c,false);banner('草稿已清除，10分钟后按规则回检。');}),action('恢复自动流程',()=>command('resume-conversation',c)));box.append(actions);e.append(box);}
}
function render(payload){data=payload;const rt=data.status.runtime||{},health=!data.status.running?'stopped':!data.status.responsive?'disconnected':rt.health;$('health').textContent=labels[health]||health;const dot=$('status-dot');dot.className='status-dot '+(['observing','connected'].includes(health)?'good':['disconnected','error'].includes(health)?'danger':'warn');$('updated').textContent='北京时间 '+fmt(data.checkedAt)+' · '+(rt.sendEnabled?'自动处理已启用':'草稿模式');$('connection').textContent=rt.lastError?'连接提示：'+rt.lastError:'';
 const metrics=[['今日新增','todayNew','首次纳入沟通','today'],['昨日新增','yesterdayNew','首次纳入沟通','yesterday'],['当前沟通','communicating','未结束的会话','active'],['待回复','pendingReply','候选人已来信','reply'],['待人工处理','humanReview','异常或配置待补齐','human'],['待批改','awaitingReview','材料齐备','awaiting_review']];$('metrics').replaceChildren(...metrics.map(([label,key,hint,filter])=>{const card=text('div','','metric'),button=document.createElement('button');button.title='查看'+label;button.append(text('span',label,'label'),document.createElement('br'),text('strong',data.metrics[key]),text('span',hint,'hint'));button.onclick=()=>{showPage('overview');$('stage-filter').value=filter;page=0;renderList();};card.append(button);return card;}));
 $('metric-definition').textContent=`统计口径：Asia/Shanghai；新增按首次纳入日期计算，${data.metrics.unknownStart} 条历史记录无首次时间。已移除 ${data.metrics.archivedTotal||0} 条：超3天 ${data.metrics.archivedInactive||0}、明确拒绝 ${data.metrics.archivedDeclined||0}、不符合要求 ${data.metrics.archivedNotQualified||0}。移除后不再巡查或回检。`;
 const platforms=data.platforms||[];options('platform-filter',platforms,'全部平台');options('account-filter',platforms.flatMap(p=>p.accounts),'全部账号');$('platform-summary').replaceChildren(...platforms.map(p=>{const e=text('div');e.append(text('strong',p.name),text('span',p.connected?'运行中':'待连接'));return e;}));
 renderList();if(pageName==='handoff')renderHandoffs();
 const ex=$('external');ex.replaceChildren(text('h3','问卷'),text('p',data.assessment.message,'sub'),text('h3','材料回收'),text('p',data.mailbox.message||labels[data.mailbox.status]||data.mailbox.status,'sub'));for(const a of data.mailbox.accounts||[])ex.append(text('p',a.id+' · '+(labels[a.status]||a.status),'sub'));
 $('notifications').replaceChildren(...data.notifications.slice().reverse().slice(0,12).map(n=>{const e=text('div','','notice');e.append(text('div',n.displayReason||n.reason||n.displayType||n.type),text('small',fmt(n.at),'sub'));return e;}));if(!data.notifications.length)$('notifications').append(text('p','暂无通知','empty'));
 const fresh=data.notifications.filter(n=>!seen.has(n.key));if(initialized&&fresh.length){banner('有 '+fresh.length+' 条新通知');if(notify&&Notification.permission==='granted')new Notification('招聘工作台有新待办',{body:'请打开本地工作台查看'});}seen=new Set(data.notifications.map(n=>n.key));initialized=true;
 if(savedRevision){$('reload-status').textContent=rt.assessmentRevision===savedRevision?'服务已生效':'已保存，等待服务生效…';}
}
async function refresh(){try{const r=await fetch('/api/state',{cache:'no-store'});if(!r.ok)throw Error();render(await r.json());}catch{$('health').textContent='连接失败';$('status-dot').className='status-dot danger';$('connection').textContent='展示数据可能已过期，请检查服务。';}}
function applySettings(s){settingsRevision=s.revision;$('assessment-url').value=s.assessment.url||'';dirty=false;$('link-expiry').textContent=s.assessment.expiresAt?'到期时间（北京时间）：'+fmt(s.assessment.expiresAt)+(s.assessment.usable?'':' · 已过期或即将过期'):'当前链接未提供明确到期时间';const status=$('settings-status');status.replaceChildren(text('h3','收件监控'));for(const m of s.mailboxes||[])status.append(text('p',`${m.address||m.id}：${m.enabled?'已启用':'未启用'}；服务器${m.hostConfigured?'已填':'未填'}，授权码${m.passwordConfigured?'已填':'未填'}`,'sub'));status.append(text('h3','模型'),text('p',s.model.configured?'参数已配置（密钥不回显）':'参数未完整配置','sub'));}
async function loadSettings(){try{const r=await fetch('/api/settings',{headers:{'X-CSRF-Token':token},cache:'no-store'});const s=await r.json();if(!r.ok)throw Error(errors[s.error]||s.error);applySettings(s);}catch(e){$('save-result').textContent=e.message;}}
let globalStageNotes={};
async function loadWorkflow(){try{const r=await fetch('/api/workflow',{headers:{'X-CSRF-Token':token},cache:'no-store'});const s=await r.json();if(!r.ok)throw Error(errors[s.error]||s.error);workflowRevision=s.revision;globalStageNotes=s.workflow.stageNotes||{};$('workflow-requirements').value=s.workflow.requirements||'';$('workflow-prompt').value=s.workflow.prompt||'';$('workflow-status').textContent='已读取 '+s.stages.length+' 个流程节点';$('workflow-stages').replaceChildren(...s.stages.map(stage=>{const e=text('div','','workflow-stage');e.append(text('strong',stage.id+' · '+stage.name),text('span',stage.description+(s.workflow.stageNotes?.[stage.id]?'；当前备注：'+s.workflow.stageNotes[stage.id]:'')));return e;}));}catch(e){$('workflow-result').textContent='读取失败：'+e.message;}}
$('assessment-url').oninput=()=>{dirty=true;$('save-result').textContent='尚未保存';};
$('reload-settings').onclick=()=>{if(!dirty||confirm('重新读取将放弃当前未保存的修改，是否继续？'))loadSettings();};
$('save-settings').onclick=async()=>{const button=$('save-settings');if(!settingsRevision)return;button.disabled=true;$('save-result').textContent='正在验证下载并保存…';try{const r=await fetch('/api/settings',{method:'POST',headers:{Origin:location.origin,'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify({url:$('assessment-url').value,revision:settingsRevision})});const s=await r.json();if(!r.ok)throw Error(errors[s.error]||s.error);applySettings(s);savedRevision=s.revision;$('save-result').textContent='保存成功，已验证 Excel 下载。';await refresh();}catch(e){$('save-result').textContent=e.message;}finally{button.disabled=false;}};
const saveWorkflow=async()=>{const button=$('save-workflow');if(!workflowRevision)return;button.disabled=true;$('workflow-result').textContent='保存中…';try{const r=await fetch('/api/workflow',{method:'POST',headers:{Origin:location.origin,'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify({revision:workflowRevision,prompt:$('workflow-prompt').value,requirements:$('workflow-requirements').value,stageNotes:globalStageNotes})});const s=await r.json();if(!r.ok)throw Error(errors[s.error]||s.error);workflowRevision=s.revision;$('workflow-status').textContent='已保存并热加载';$('workflow-result').textContent='流程配置已生效。';}catch(e){$('workflow-result').textContent='保存失败：'+e.message;}finally{button.disabled=false;}};
$('save-workflow').onclick=saveWorkflow;$('reload-workflow').onclick=loadWorkflow;
let jobDirty=false,jobBusy=false,editingJobStatus;
const jobFormFields={name:'name',acceptedTitles:'titles',education:'education',majors:'major',excluded:'excluded',intent:'intent',requirements:'requirements',prompt:'prompt',url:'url',onPass:'pass',onMissing:'missing',onFail:'fail'};
const jobLists=new Set(['acceptedTitles','education','majors','excluded']);
const discardJob=()=>!jobDirty||confirm('放弃当前岗位未保存的修改？');
function jobBusyState(busy){
  jobBusy=busy;
  for(const id of ['job-fields','job-select','save-job','add-job','add-portfolio','add-flow'])$(id).disabled=busy||!jobsRevision;
  $('reload-jobs').disabled=busy;
}
let flowRules=[];
const flowLabels={reply:'发送指定话术',questionnaire:'询问问卷意愿',handoff:'转人工',wait:'等待来信'};
function flowFeedback(message){
  $('flow-feedback').textContent=message;
  $('flow-feedback').hidden=!message;
}
function flowChanged(){
  jobDirty=true;
  $('job-result').textContent='动态岗位有未保存的修改';
}
function renderFlowRules(){
  const box=$('flow-rows');
  box.replaceChildren();
  flowRules.forEach((rule,index)=>{
    const section=text('section','','job-section'), fields=text('div','','job-grid');
    const toolbar=text('div','','job-toolbar');
    toolbar.append(text('strong','规则 '+(index+1)));
    const addButton=(name,disabled,handler)=>{
      const button=text('button',name,'small');
      button.type='button';button.disabled=disabled;
      button.onclick=()=>{handler();flowChanged();renderFlowRules();};
      toolbar.append(button);
    };
    addButton('上移',index===0||rule.after===flowRules[index-1]?.id,()=>{
      [flowRules[index-1],flowRules[index]]=[rule,flowRules[index-1]];
    });
    addButton('下移',index===flowRules.length-1||flowRules[index+1]?.after===rule.id,()=>{
      [flowRules[index+1],flowRules[index]]=[rule,flowRules[index+1]];
    });
    addButton('移除',flowRules.some(r=>r.after===rule.id),()=>flowRules.splice(index,1));
    const addField=(caption,control)=>{
      const label=document.createElement('label');
      label.append(caption,control);fields.append(label);
    };
    const condition=document.createElement('textarea');
    condition.required=true;condition.maxLength=600;condition.value=rule.condition;
    condition.placeholder='例如：候选人明确表示有角色设计作品，且愿意投递作品集';
    condition.oninput=()=>{rule.condition=condition.value;};
    addField('触发条件',condition);
    const after=document.createElement('select');
    after.add(new Option('无前置步骤',''));
    flowRules.slice(0,index).forEach((r,i)=>{if(r.action==='reply')after.add(new Option('规则 '+(i+1)+' 的话术已送达',r.id));});
    after.value=rule.after;after.onchange=()=>{rule.after=after.value;renderFlowRules();};
    addField('前置条件',after);
    const action=document.createElement('select');
    Object.entries(flowLabels).forEach(([id,label])=>action.add(new Option(label,id)));
    action.value=rule.action;
    action.onchange=()=>{
      if(flowRules.some(r=>r.after===rule.id)&&action.value!=='reply'){
        action.value=rule.action;flowFeedback('请先修改依赖这条话术的前置条件。');return;
      }
      rule.action=action.value;renderFlowRules();
    };
    addField('命中后执行',action);
    if(rule.action==='reply'){
      const message=document.createElement('textarea');
      message.required=true;message.maxLength=1500;message.value=rule.text;
      message.oninput=()=>{rule.text=message.value;};
      addField('对外话术',message);
    }
    section.append(toolbar,fields);box.append(section);
  });
}
$('add-flow').onclick=()=>{
  if(!discardJob())return;
  editJob({id:crypto.randomUUID(),name:'',acceptedTitles:[],status:'dynamic',requirements:'',flow:{rules:[],fallback:'handoff'}});
  $('job-name').focus();
};
$('flow-add').onclick=()=>{
  if(flowRules.length>=20)return flowFeedback('每个岗位最多配置 20 条规则。');
  flowRules.push({id:crypto.randomUUID(),condition:'',action:'handoff',text:'',after:''});
  flowChanged();renderFlowRules();
};
async function flowRequest(kind){
  if(jobBusy)return;
  if(kind==='draft'&&flowRules.length&&!confirm('用模型生成的草稿替换当前表单中的规则？'))return;
  const job=readJobForm();
  if(kind==='draft'&&!job.requirements.trim())return flowFeedback('请先填写岗位要求与流程文档。');
  if(kind==='preview'&&!$('flow-sample').value.trim())return flowFeedback('请先填写示例来信。');
  jobBusyState(true);flowFeedback('模型处理中…');
  try{
    const response=await fetch('/api/flow/'+kind,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':token},
      body:JSON.stringify({...job,sample:$('flow-sample').value})});
    const data=await response.json();
    if(!response.ok)throw Error(({INVALID_FLOW_RULE:'请检查触发条件、前置步骤及对外话术。',MODEL_NOT_CONFIGURED:'模型尚未配置。',MODEL_ANALYSIS_INVALID:'模型返回的规则或证据无效，请重试。'})[data.error]||data.error);
    if(kind==='draft'){
      const ids=new Map(data.flow.rules.map(r=>[r.id,crypto.randomUUID()]));
      flowRules=data.flow.rules.map(r=>({...r,id:ids.get(r.id),after:ids.get(r.after)||''}));
      $('flow-fallback').value=data.flow.fallback;
      flowChanged();renderFlowRules();flowFeedback('草稿已生成，可调整优先顺序和话术，保存后生效。');
    }else{
      const label={send:'发送话术',wait:'等待来信',handoff:'转人工'}[data.action]||data.action;
      flowFeedback([label,data.reason,data.text,...(data.evidence||[]).map(e=>'判定依据 · '+e.quote)].filter(Boolean).join('\n'));
    }
  }catch(e){flowFeedback('处理失败 · '+e.message);}
  finally{jobBusyState(false);}
}
$('flow-generate').onclick=()=>flowRequest('draft');
$('flow-preview').onclick=()=>flowRequest('preview');

function editJob(job){
  selectedJobId=job.id;
  editingJobStatus=job.status;
  const portfolio=job.status==='manual_portfolio';
  const dynamic=job.status==='dynamic';
  const manual=portfolio||job.status==='manual_draft';
  $('flow-editor').hidden=!dynamic;
  $('job-notes').hidden=dynamic;
  $('flow-doc').value=dynamic?job.requirements:'';
  $('flow-url').value=dynamic?job.url||'':'';
  $('flow-sample').value='';
  $('flow-feedback').hidden=true;
  $('flow-fallback').value=job.flow?.fallback||'handoff';
  flowRules=structuredClone(job.flow?.rules||[]);
  renderFlowRules();
  $('portfolio-rules').hidden=!portfolio;
  $('portfolio-entry').hidden=!portfolio||!jobs.some(item=>item.id===job.id);
  $('portfolio-link').href='/portfolio?job='+encodeURIComponent(job.id);
  $('pf-cohort').value=job.cohort||'';
  $('pf-education').value=(job.education||[]).join('、');
  $('pf-grades').value=(job.blockedGrades||[]).join('、');
  $('pf-majors').value=(job.majors||[]).join('\n');
  $('job-draft-status').hidden=job.status!=='manual_draft';
  $('job-binding').hidden=manual;
  $('job-automatic-rules').hidden=manual||dynamic;
  $('job-education').required=!manual&&!dynamic;
  $('job-form').classList.toggle('manual-draft',manual);
  $('job-rules-label').textContent=manual?'岗位要求与判定规则':'资料核验补充要求';
  $('job-prompt-label').textContent=manual?'人工流程与话术':'AI 提示词补充';
  const opts=jobs.map(item=>new Option(item.name+(item.status==='manual_draft'?'（草案）':item.status==='manual_portfolio'?'（无问卷）':item.status==='dynamic'?'（动态）':''),item.id));
  if(!jobs.some(item=>item.id===job.id))opts.push(new Option('新增岗位',job.id));
  $('job-select').replaceChildren(...opts);
  $('job-select').value=job.id;
  for(const [key,id] of Object.entries(jobFormFields)){
    const value=job[key];
    $('job-'+id).value=Array.isArray(value)?value.join(key==='majors'?'\n':'、'):(value??'');
  }
  $('job-senior').checked=job.senior;
  jobDirty=false;
  $('job-result').textContent='';
}
function readJobForm(){
  if(editingJobStatus==='dynamic'){
    const name=$('job-name').value.trim();
    const titles=$('job-titles').value.split(/[、,，\n]/).map(v=>v.trim()).filter(Boolean);
    return {id:selectedJobId,status:'dynamic',name,acceptedTitles:titles.length?titles:[name],requirements:$('flow-doc').value,
      url:$('flow-url').value.trim(),flow:{rules:flowRules,fallback:$('flow-fallback').value}};
  }
  if(editingJobStatus==='manual_portfolio'){
    const parts=id=>$(id).value.split(/[、,，\n]/).map(v=>v.trim()).filter(Boolean);
    return {id:selectedJobId,status:editingJobStatus,acceptedTitles:[],name:$('job-name').value.trim(),
      requirements:$('job-requirements').value,prompt:$('job-prompt').value,cohort:$('pf-cohort').value,
      education:parts('pf-education'),majors:parts('pf-majors'),blockedGrades:parts('pf-grades')};
  }
  if(editingJobStatus==='manual_draft'){
    return {id:selectedJobId,name:$('job-name').value.trim(),status:'manual_draft',acceptedTitles:[],
      requirements:$('job-requirements').value,prompt:$('job-prompt').value};
  }
  const job={id:selectedJobId,senior:$('job-senior').checked};
  for(const [key,id] of Object.entries(jobFormFields)){
    const value=$('job-'+id).value.trim();
    job[key]=jobLists.has(key)?value.split(/[、,，\n]/).map(item=>item.trim()).filter(Boolean):value;
  }
  if(!job.acceptedTitles.length)job.acceptedTitles=[job.name];
  return job;
}
async function loadJobs(){
  if(jobBusy)return;
  jobBusyState(true);
  try{
    const response=await fetch('/api/job-profiles',{headers:{'X-CSRF-Token':token}});
    const view=await response.json();
    if(!response.ok)throw Error(errors[view.error]||'岗位读取失败');
    jobsRevision=view.revision;jobs=view.jobs;
    editJob(jobs.find(item=>item.id===selectedJobId)||jobs[0]);
  }catch(e){$('job-result').textContent=e.message;}
  finally{jobBusyState(false);}
}
$('reload-jobs').onclick=()=>{if(discardJob())loadJobs();};
$('job-select').onchange=()=>{
  if(!discardJob()){$('job-select').value=selectedJobId;return;}
  editJob(jobs.find(item=>item.id===$('job-select').value));
};
$('add-job').onclick=()=>{
  if(!discardJob())return;
  editJob({id:crypto.randomUUID(),name:'',acceptedTitles:[],education:['本科','硕士','博士'],senior:true,majors:[],excluded:[],intent:'',url:'',requirements:'',prompt:'',onPass:'human',onMissing:'clarify',onFail:'human'});
  $('job-name').focus();
};
$('add-portfolio').onclick=()=>{
  if(!discardJob())return;
  editJob({id:crypto.randomUUID(),status:'manual_portfolio',acceptedTitles:[],education:['大专','本科','硕士','博士'],
    requirements:'',prompt:'S2 通过与邮箱投递\n\nS3 学历婉拒\n\nS4 专业婉拒\n\nS5 资料补问\n\nS6 拒收聊天附件与邮箱引导\n'});
  $('job-result').textContent='请在 S2 至 S6 各标题的下一行填写对外话术，并在投递引导中写明邮箱。';
  $('job-name').focus();
};
$('job-form').oninput=()=>{jobDirty=true;$('job-result').textContent='有未保存的修改';};
$('job-form').onsubmit=async(event)=>{
  event.preventDefault();
  if(jobBusy||!jobsRevision)return;
  const job=readJobForm();
  jobBusyState(true);
  $('job-result').textContent='正在保存岗位…';
  try{
    const response=await fetch('/api/job-profiles',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify({revision:jobsRevision,job})});
    const view=await response.json();
    if(!response.ok)throw Error(errors[view.error]||view.error);
    jobs=view.jobs;jobsRevision=view.revision;
    editJob(jobs.find(item=>item.id===job.id));
    $('job-result').textContent=job.status==='manual_draft'?'岗位草案已保存。':job.status==='manual_portfolio'?'已保存，可打开候选人工作台。':'已保存。运行中的账号将在下一轮监控时读取。';
  }catch(e){$('job-result').textContent='保存失败：'+e.message;}
  finally{jobBusyState(false);}
};
function syncSearchClear(){ $('clear-search').hidden=!$('search').value; }
async function runHeaderCommand(id,name){const button=$(id);button.disabled=true;button.setAttribute('aria-busy','true');try{await command(name);}catch(e){banner(e.message);}finally{button.disabled=false;button.removeAttribute('aria-busy');}}
for(const id of ['platform-filter','account-filter','stage-filter','search'])$(id).addEventListener(id==='search'?'input':'change',()=>{if(id==='search'&&pageName!=='overview')showPage('overview');page=0;renderList();if(id==='search')syncSearchClear();});$('clear-search').onclick=()=>{$('search').value='';syncSearchClear();page=0;renderList();$('search').focus();};$('previous').onclick=()=>{page--;renderList();};$('next').onclick=()=>{page++;renderList();};$('pause').onclick=()=>runHeaderCommand('pause','pause');$('resume').onclick=()=>runHeaderCommand('resume','resume');$('notify').onclick=async()=>{if(!('Notification'in window))return banner('浏览器不支持桌面通知');notify=(await Notification.requestPermission())==='granted';$('notify').textContent=notify?'提醒已开启':'权限未开启';};syncSearchClear();refresh();setInterval(refresh,2000);

let aiGuide=null;
let accountCache=[];
function accountStateClass(status){return status==='connected'?'good':status==='logged_out'||status==='not_started'?'warn':'sub';}
function monitorStateClass(status){return status==='observing'||status==='connected'?'good':status==='paused'?'warn':'sub';}
async function monitorAction(profile,actionName){const r=await fetch(`/api/monitors/${encodeURIComponent(profile)}`,{method:'POST',headers:{Origin:location.origin,'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify({action:actionName})});const body=await r.json();if(!r.ok)throw Error(body.error||'监控操作失败');banner(`${profile} 监控${actionName==='start'?'已启动':actionName==='stop'?'已停止':actionName==='pause'?'已暂停':'已恢复'}`);await loadAccounts();}
function renderAccounts(accounts,monitors=[]){accountCache=accounts;const box=$('account-list');const monitorMap=new Map(monitors.map(item=>[item.profile,item]));box.replaceChildren();if(!accounts.length){box.append(text('p','还没有注册招聘账号。','empty'));return;}for(const a of accounts){const m=monitorMap.get(a.profile),card=text('div','','account-card');const info=document.createElement('div');info.append(text('strong',a.label||a.id),text('div',`${a.id} · 端口 ${a.port}`,'state'),text('div',a.displayName?`平台显示名：${a.displayName}`:'登录后自动核验','state'));if(m){const reason=m.lastError?monitorErrors[m.lastError]||m.lastError:m.recovery?.state==='recovering'?'正在自动恢复浏览器':m.recovery?.state==='recovery_failed'?'浏览器自动恢复失败':null;info.append(text('div',`自动监控：${m.running?(labels[m.health]||m.health):m.selected?'启动中':'未启动'}`,'state '+monitorStateClass(m.health)));if(reason)info.append(text('div',reason,'state warn'));}const right=text('div','','bar');right.append(text('span',labels[a.status]||a.status,'state '+accountStateClass(a.status)),action('编辑',()=>{editingAccountId=a.id;$('account-id').value=a.id;$('account-label').value=a.label||'';$('account-display').value=a.displayName||'';$('account-id').disabled=true;accountForm(true);}),action(a.status==='connected'?'刷新状态':'打开登录',async()=>{const endpoint=a.status==='connected'?`/api/accounts/${encodeURIComponent(a.id)}/refresh`:`/api/accounts/${encodeURIComponent(a.id)}/login`;const r=await fetch(endpoint,{method:'POST',headers:{'Origin':location.origin,'X-CSRF-Token':token}});const body=await r.json();if(!r.ok)throw Error(body.error||'账号操作失败');banner(a.status==='connected'?'账号状态已刷新':'专用登录窗口已打开，请完成登录后刷新状态');await loadAccounts();}));if(m?.running){right.append(action('暂停监控',()=>monitorAction(a.profile,'pause')),action('停止监控',()=>monitorAction(a.profile,'stop')));if(m.health==='paused')right.append(action('恢复运行',()=>monitorAction(a.profile,'resume'),true));}else if(m){right.append(action('启动监控',()=>monitorAction(a.profile,'start'),true));}card.append(info,right);box.append(card);}}
async function loadAccounts(){try{const [accountsResponse,monitorResponse]=await Promise.all([fetch('/api/accounts',{headers:{'X-CSRF-Token':token},cache:'no-store'}),fetch('/api/monitor-status',{cache:'no-store'})]);const d=await accountsResponse.json(),m=await monitorResponse.json();if(!accountsResponse.ok)throw Error(d.error||'账号读取失败');renderAccounts(d.accounts||[],monitorResponse.ok?m.monitors||[]:[]);}catch(e){$('account-list').replaceChildren(text('p','账号状态读取失败：'+e.message,'empty'));}}
function accountForm(show){$('account-form').hidden=!show;$('account-result').textContent='';if(!show){editingAccountId=null;$('account-id').value='';$('account-label').value='';$('account-display').value='';$('account-id').disabled=false;}}
async function watchLogin(id){for(let i=0;i<120;i++){await new Promise(r=>setTimeout(r,3000));try{const r=await fetch(`/api/accounts/${encodeURIComponent(id)}/refresh`,{method:'POST',headers:{Origin:location.origin,'X-CSRF-Token':token}});const d=await r.json();await loadAccounts();if(r.ok&&d.status==='connected'){banner(`账号 ${d.displayName||id} 已登录并完成绑定。`);return;}}catch{}}banner('仍未检测到招聘页面登录，请完成扫码后在账号管理中刷新。');}
async function beginAddAccount(){const button=$('add-account');button.disabled=true;try{const r=await fetch('/api/accounts/prepare',{method:'POST',headers:{Origin:location.origin,'X-CSRF-Token':token}}),d=await r.json();if(!r.ok)throw Error(d.error||'账号启动失败');const account=d.account?.account||d.account;banner(`专用登录窗口已打开（${account?.id||'新账号'}），请扫码或正常登录；系统会自动检测。`);await loadAccounts();if(account?.id)watchLogin(account.id);}catch(e){banner(e.message);}finally{button.disabled=false;}}
$('add-account').onclick=beginAddAccount;$('cancel-account').onclick=()=>accountForm(false);
$('save-account').onclick=async()=>{const id=$('account-id').value.trim(),label=$('account-label').value.trim(),displayName=$('account-display').value.trim();const button=$('save-account');button.disabled=true;try{const endpoint=editingAccountId?`/api/accounts/${encodeURIComponent(editingAccountId)}`:'/api/accounts';const r=await fetch(endpoint,{method:editingAccountId?'PATCH':'POST',headers:{Origin:location.origin,'Content-Type':'application/json','X-CSRF-Token':token},body:JSON.stringify({id,label,displayName})});const d=await r.json();if(!r.ok)throw Error(d.error||'账号保存失败');$('account-result').textContent='保存成功。';accountForm(false);await loadAccounts();}catch(e){$('account-result').textContent=e.message;}finally{button.disabled=false;}};
$('refresh-accounts').onclick=loadAccounts;
async function loadAiGuide(){
 try{const r=await fetch('/api/ai-guide',{cache:'no-store'});if(!r.ok)throw Error('说明加载失败，请稍后重试');aiGuide=await r.json();$('ai-base-url').value=aiGuide.localBaseUrl;$('ai-credential-path').value=aiGuide.localCredentialPath;
 $('ai-routes').replaceChildren(...aiGuide.routes.map(route=>{const e=text('div','','guide-route');e.append(text('code','GET '+route.path),text('span',route.description));return e;}));
 $('ai-doc-path').textContent='完整说明：'+aiGuide.documentationPath;
 $('ai-local-command').textContent='& "'+aiGuide.localPythonPath+'" -X utf8 "'+aiGuide.localScriptPath+'"';updateAiPrompt();
 }catch(e){$('ai-copy-result').textContent=e.message;}
}
function updateAiPrompt(){
 if(!aiGuide)return;const remote=$('ai-mode').value==='remote',base=$('ai-base-url').value.trim().replace(/\/$/,''),file=$('ai-credential-path').value.trim();let valid=true;
 try{const u=new URL(base);valid=!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/'&&(remote?u.protocol==='https:'&&!['localhost','127.0.0.1','[::1]'].includes(u.hostname):u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname));}catch{valid=false;}
 valid=valid&&!!file&&!/[\r\n]/.test(file);
 $('ai-mode-note').textContent=remote?'异机模式：填写已经部署的 HTTPS API 地址，以及 AI 调用端上的凭据路径。此处输入仅生成提示词，不修改平台配置。':'同机模式：AI 需要能在这台 Windows 电脑执行命令并读取凭据文件；不会显示文件中的 Token。';
 let prompt=aiGuide.instructions.replace('{{BASE_URL}}',base||'【填写HTTPS API地址】').replace('{{CREDENTIAL_PATH}}',file||'【填写AI调用端凭据文件路径】');
 const quote=v=>"'"+v.replaceAll("'","''")+"'";
 const localCommand='& '+quote(aiGuide.localPythonPath)+' -X utf8 '+quote(aiGuide.localScriptPath)+' --config '+quote(file)+' --base-url '+quote(base);
 $('ai-local-command').textContent=remote?'异机运行请使用调用端可用的 HTTP 工具，按上方提示词读取本地凭据并访问部署后的 HTTPS 地址。':localCommand;
 if(!remote)prompt+='\n\n本机首次查询可直接执行 PowerShell：\n'+localCommand+'\n该脚本仅输出脱敏运行快照。人工待办明细请再用同一鉴权读取 handoffs 接口。';
 $('ai-prompt').value=prompt;$('copy-ai-prompt').disabled=!valid;$('ai-copy-result').textContent=valid?'提示词已准备好，可直接复制。':'请填写有效的基础地址和调用端凭据文件路径。';
}
$('ai-mode').onchange=()=>{if(!aiGuide)return;const remote=$('ai-mode').value==='remote';$('ai-base-url').value=remote?'':aiGuide.localBaseUrl;$('ai-base-url').placeholder=remote?'https://你的API域名':aiGuide.localBaseUrl;$('ai-credential-path').value=remote?'':aiGuide.localCredentialPath;updateAiPrompt();};
$('ai-base-url').oninput=updateAiPrompt;$('ai-credential-path').oninput=updateAiPrompt;
$('select-ai-prompt').onclick=()=>{$('ai-prompt').focus();$('ai-prompt').select();$('ai-copy-result').textContent='已全选，请按 Ctrl+C（Mac 使用 Cmd+C）复制。';};
$('copy-ai-prompt').onclick=async()=>{try{await navigator.clipboard.writeText($('ai-prompt').value);$('ai-copy-result').textContent='已复制，粘贴给 AI 工具即可。';}catch{$('ai-prompt').focus();$('ai-prompt').select();$('ai-copy-result').textContent='浏览器未允许自动复制，已全选，请按 Ctrl+C（Mac 使用 Cmd+C）。';}};
const initialPage=location.hash.slice(1);if(['overview','handoff','settings','ai-access'].includes(initialPage))showPage(initialPage);
window.addEventListener('hashchange',()=>{const name=location.hash.slice(1);if(['overview','handoff','settings','ai-access'].includes(name))showPage(name);});
