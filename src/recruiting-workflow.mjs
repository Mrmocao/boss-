import {portfolioTemplates,screenPortfolio} from './portfolio-workflow.mjs';
import { planDynamic } from './dynamic-flow.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { projectRoot } from './config.mjs';
import { markHandoff } from './monitor-core.mjs';

const exec = promisify(execFile);
export async function loadWorkflowPolicy() {
  const python=resolve(projectRoot,'../.tools/python/python.exe');
  const {stdout}=await exec(python,['-X','utf8',resolve(projectRoot,'scripts/export_workflow_config.py')],{windowsHide:true,timeout:10000,maxBuffer:300000});
  return JSON.parse(stdout);
}
export const incomingBatch = c => {
  const messages=c.messages || [];
  const lastOut=messages.findLastIndex(m=>m.direction==='outgoing');
  return messages.slice(lastOut+1).filter(m=>m.direction==='incoming').map(m=>m.text||m.displayText||'').join('\n');
};
const sourceTexts=(c,source)=> source==='profile_education' ? c.detail?.candidate?.educationText||[]
  : source==='candidate_message' ? (c.messages||[]).filter(m=>m.direction==='incoming').map(m=>m.text||'') : [];
const validEvidence=(value,c)=>value && typeof value.quote==='string' && value.quote.trim().length>=2
  && sourceTexts(c,value.source).some(t=>t.includes(value.quote));

export function validateAnalysis(a,c) {
  const invalid=()=>{throw Object.assign(new Error('MODEL_ANALYSIS_INVALID'),{code:'MODEL_ANALYSIS_INVALID'});};
  if(!a||!Array.isArray(a.education)||a.education.length>10||!['yes','no','unknown'].includes(a.intent?.value)
    ||!['salary','abnormal','none'].includes(a.concern?.kind)||!['yes','no','unknown'].includes(a.consent?.value))invalid();
  for(const e of a.education) {
    if(!validEvidence(e,c)||!['本科','硕士','博士','大专','专科','高中','unknown'].includes(e.level)
      ||typeof e.major!=='string'||e.major.length>100||!['graduated','senior','other','unknown'].includes(e.stage)
      ||(e.level!=='unknown'&&!e.quote.includes(e.level))||(e.major&&!e.quote.includes(e.major)))invalid();
    // A degree/major pair must come from a single quoted record, never two schools.
    if(e.stage!=='unknown') {
      if(!validEvidence(e.stageEvidence,c))invalid();
      if(e.stage==='senior'&&!/大四|四年级/.test(e.stageEvidence.quote))invalid();
      if(e.stage==='graduated'&&!/毕业|\d{4}届/.test(e.stageEvidence.quote))invalid();
    }
  }
  if(a.intent.value!=='unknown'&&!validEvidence(a.intent,c))invalid();
  if(a.highestEducation?.level && a.highestEducation.level!=='unknown' && (!validEvidence(a.highestEducation,c)||!a.highestEducation.quote.includes(a.highestEducation.level)||!/最高学历/.test(a.highestEducation.quote)))invalid();
  if(a.concern.kind!=='none'&&(typeof a.concern.quote!=='string'||!incomingBatch(c).includes(a.concern.quote)||a.concern.quote.length<2))invalid();
  if(a.consent.value!=='unknown'&&(typeof a.consent.quote!=='string'||!a.consent.quote.trim()||!incomingBatch(c).includes(a.consent.quote)))invalid();
  if(a.consent.value==='yes' && (/不愿|不想|不做|不方便|没空|没时间|考虑|再说|如果|但是|不过/.test(a.consent.quote)
    ||!/愿意|同意|可以|好的|好啊|行的|没问题|发我|发来|有空|能做|^(好|行)$/.test(a.consent.quote)||/有空再|之后再|等.*再/.test(incomingBatch(c))))invalid();
  if(a.intent.value==='yes'&&/不想|不考虑|没有意向|不愿/.test(a.intent.quote))invalid();
  return a;
}

export function screenCandidate(a,policy) {
  const rules=policy.rules.screening.rules;
  const job=policy.job;
  const majorRule=rules.find(r=>r.id==='H2');
  const white=job?.majors??Object.values(majorRule.whitelist).flat();
  const excluded=job?.excluded??majorRule.explicit_excluded_categories??[];
  const levels=job?.education??rules.find(r=>r.id==='H1').accepted_levels;
  const intent=job?job.intent:'游戏策划';
  const matching=a.education.filter(e=>levels.includes(e.level)&&(!white.length||white.includes(e.major))
    &&(!excluded.length||(e.major&&!excluded.includes(e.major)))
    &&(e.stage==='graduated'||(e.stage==='senior'&&(job?.senior??true))));
  if(matching.length&&(!intent||a.intent.value==='yes'))return {outcome:'pass',evidence:matching};
  if(intent&&a.intent.value==='no')return {outcome:'fail',reason:'明确的'+intent+'求职意向'};
  if(a.highestEducation?.level&&a.highestEducation.level!=='unknown'&&!levels.includes(a.highestEducation.level))return {outcome:'fail',reason:'岗位要求的学历范围（'+levels.join('、')+'）'};
  if(a.education.length&&a.education.every(e=>excluded.includes(e.major)))return {outcome:'fail',reason:'岗位要求的专业范围'};
  if(!matching.length&&white.length&&a.education.some(e=>levels.includes(e.level)&&e.major&&!white.includes(e.major)))return {outcome:'review',reason:'专业需人工归类'};
  const missing=[];
  if(!matching.length){
    if(!a.education.length||a.education.some(e=>e.level==='unknown'||e.stage==='unknown'))missing.push('学历和目前毕业／在读阶段');
    if((white.length||excluded.length)&&(!a.education.length||a.education.some(e=>!e.major)))missing.push('专业');
    if(!missing.length)return {outcome:'review',reason:'学历或专业条件需人工复核'};
  }
  if(intent&&a.intent.value==='unknown')missing.push('是否希望从事'+intent+'工作');
  return {outcome:'missing',missing};
}

export function recoverWorkflow(c,intents={}) {
  c.workflow ??= {stage:'screening'};
  const confirmed=Object.values(intents).filter(i=>i.conversationId===c.id&&i.status==='sent_confirmed');
  if(c.workflow.stage==='screening') {
    if(confirmed.some(i=>i.messageId==='S3'||i.messageId==='PORTFOLIO_INVITE'))c.workflow.stage='waiting_email';
    else if(confirmed.some(i=>i.messageId==='S1'))c.workflow.stage='waiting_consent';
    else if(confirmed.some(i=>i.messageId==='S6'))c.workflow.stage='waiting_clarification';
  }
  c.clarificationCount=Math.max(Number.isInteger(c.clarificationCount)?c.clarificationCount:0,confirmed.filter(i=>i.messageId==='S6').length);
  return c.workflow;
}

export function questionnaireExpiresAt(config) {
  try{const value=new URL(config.assessment?.url).searchParams.get('Expires');if(!value||!/^\d+$/.test(value))return null;const date=new Date(Number(value)*1000);return Number.isFinite(date.getTime())?date.toISOString():null;}catch{return null;}
}
export function questionnaireUrl(config,now=Date.now()) {
  try {
    const u=new URL(config.assessment?.url);
    if(u.protocol!=='https:'||u.username||u.password||['localhost','127.0.0.1'].includes(u.hostname))return null;
    const expires=u.searchParams.get('Expires');
    if(expires!==null&&(!/^\d+$/.test(expires)||!Number.isFinite(Number(expires))||Number(expires)*1000<=now+60000))return null;
    return u.href;
  }catch{return null;}
}
export function planWorkflow(c,a,policy,config,intents={}) {
  const wf=recoverWorkflow(c,intents), batch=incomingBatch(c);
  const handoff=reason=>({type:'handoff',reason,messageId:'S5'});
  const text=(id,vars={})=>policy.messages[id].text.replace(/\{([A-Z_]+)\}/g,(_,key)=>vars[key]??'');
  const send=(id,body,nextStage)=>({type:'send',messageId:id,text:body,nextStage});
  if(c.human_handoff)return {type:'wait'};
  if(/薪资|薪酬|工资|奖金|待遇|加班|几薪|双休|社保|公积金/.test(batch))return handoff('薪资政策问题，等待人工回复');
  if(a.concern.kind!=='none')return handoff(a.portfolioFacts?.concern?.value||'异常问题，等待人工回复');
  if(/(?:是|是不是|是否).{0,8}(?:AI|人工智能|机器人|自动回复)|真人吗/i.test(batch))
    return send('IDENTITY','我是协助招聘同事处理沟通的自动化助手，具体招聘安排会由招聘同事确认。',wf.stage);
  if(['rejected_screening','declined_test','do_not_contact','awaiting_review'].includes(wf.stage))return handoff('终态收到新消息');
  if(policy.job?.status==='manual_portfolio'){
    const job=policy.job, facts=a.portfolioFacts;
    if(job.delivery!=='automatic'||!facts)return handoff('作品岗位需人工核实');
    if(/全职|社招|正式岗/.test(batch))return handoff('候选人提到正式岗位，请核对申请方向');
    const templates=portfolioTemplates(job.prompt);
    if(c.pendingAttachmentGuidance)return send('S7',templates.S6,c.pendingAttachmentGuidance.nextStage);
    if(c.detail?.attachmentRequests?.some(r=>r.status==='pending'))return {type:'reject_attachment',messageId:'S7',text:templates.S6,nextStage:wf.stage};
    if(c.messages?.findLast(m=>m.direction==='incoming')?.kind==='attachment')return send('S7',templates.S6,wf.stage);
    if(wf.stage==='waiting_email')return {type:'wait',reason:'等待人工核对简历和作品集'};
    if(!['screening','waiting_clarification','waiting_reply'].includes(wf.stage))return handoff('请核对原会话的流程阶段');
    const {step,note}=screenPortfolio(job,facts,c.clarificationCount>0);
    if(step==='wait')return {type:'wait',reason:note};
    if(step==='S7')return handoff(note);
    if(step==='S5'){
      const missing=[!facts.enrollment&&'目前是否在读',!facts.year&&'预计毕业年份'].filter(Boolean);
      return send('S6',templates.S5+(missing.length?'也请补充'+missing.join('和')+'。':''),'waiting_clarification');
    }
    if(step==='S3'||step==='S4'){
      return send('S4',templates[step],'rejected_screening');
    }
    return {...send('PORTFOLIO_INVITE',templates.S2,'waiting_email'),portfolioJobId:job.id,screening:{outcome:'pass',reason:note}};
  }
  if(policy.job?.status==='dynamic' && (c.pendingAttachmentGuidance || c.detail?.attachmentRequests?.some(r=>r.status==='pending')))return handoff('动态岗位收到附件请求，请人工核实投递渠道');
  if(c.pendingAttachmentGuidance)return send('S7',text('S7',{EMAIL:policy.rules.questionnaire.collection_email}),c.pendingAttachmentGuidance.nextStage);
  if((c.detail?.attachmentRequests||[]).some(r=>r.status==='pending'))return {type:'reject_attachment',messageId:'S7',text:text('S7',{EMAIL:policy.rules.questionnaire.collection_email}),nextStage:wf.stage};
  if(wf.stage==='waiting_email'||wf.stage==='submission_incomplete')return {type:'wait',reason:'等待邮箱中的真实附件回执'};
  if(wf.stage==='assessment_file_sent')return handoff('试题文件已送达，回收说明尚未确认，请人工核对；禁止重发文件');
  if(wf.stage==='waiting_consent'||wf.stage==='test_pending') {
    const s1=Object.values(intents).find(i=>i.conversationId===c.id&&i.status==='sent_confirmed'&&i.messageId==='S1');
    if(!s1)return handoff('缺少 S1 发送回执');
    const s1Index=(c.messages||[]).findLastIndex(m=>m.direction==='outgoing'&&m.text===s1.text);
    if(s1Index<0)return handoff('当前消息窗口缺少 S1，不能核实问卷同意语境');
    if(!a.consent)return handoff('问卷意愿需要重新核实');
    if(a.consent.value==='no')return send('DECLINE_TEST',text('DECLINE_TEST'),'declined_test');
    if(a.consent.value!=='yes')return handoff('问卷意愿不明确');
    const fileDelivery=config.assessment?.delivery!=='link';
    if(!config.allowAssessment||(fileDelivery?!config.assessment?.filePath:!questionnaireUrl(config)))return {type:'blocked',reason:fileDelivery?'请配置试题文件路径并启用发题':'试题链接已过期、即将过期或未配置，请更新有效链接',nextStage:'test_pending',consentEvidence:a.consent};
    const token=c.workflow.receiptToken||('BOSS-'+createHash('sha256').update(config.expectedAccountDisplayName+'|'+c.id+'|'+s1.id).digest('hex').slice(0,16).toUpperCase());
    const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
    const subjectNote=`\n邮件主题请写：姓名-岗位-提交日期（例如：${c.name}-${c.jobTitle}-${today}，日期按实际提交当天填写）。`;
    const emailSubjectFormat='name-job-submission-date';
    if(fileDelivery)return {type:'send_file',messageId:'S3',delivery:'file',filePath:config.assessment.filePath,text:text('S3_FILE',{EMAIL:policy.rules.questionnaire.collection_email})+subjectNote,nextStage:'waiting_email',receiptToken:token,emailSubjectFormat};
    return {...send('S3',text('S3',{TEST_LINK:questionnaireUrl(config),EMAIL:policy.rules.questionnaire.collection_email})+subjectNote,'waiting_email'),receiptToken:token,emailSubjectFormat};
  }
  if(policy.job?.status==='dynamic')return planDynamic(c,a,policy.job,text('S1'));
  const result=screenCandidate(a,policy);
  if(result.outcome==='pass'&&policy.job?.onPass==='human')return handoff('岗位要求初筛通过后交人工跟进');
  if(result.outcome==='missing'&&policy.job?.onMissing==='human')return handoff('岗位要求资料缺失时人工核实');
  if(result.outcome==='fail'&&policy.job?.onFail==='human')return handoff(result.reason);
  if(result.outcome==='review')return handoff(result.reason);
  if(result.outcome==='fail')return send('S4',text('S4',{REASON:result.reason}),'rejected_screening');
  if(result.outcome==='missing') {
    if(c.clarificationCount>=1)return handoff('已补问一次，硬条件仍不完整');
    return {...send('S6',text('S6',{MISSING_FIELDS:result.missing.join('、')}),'waiting_clarification'),questions:result.missing};
  }
  return {...send('S1',text('S1'),'waiting_consent'),screening:result};
}

export function recordPlan(state,cid,fingerprint,plan,analysis) {
  const c=state.conversations[cid];
  if(!c||c.fingerprint!==fingerprint||c.human_handoff||state.controls.paused)return false;
  c.analysis=analysis;c.plan=plan;c.workflow??={stage:'screening'};
  if(plan.type==='handoff')markHandoff(state,cid,plan.reason);
  if(plan.type==='blocked') {
    c.workflow.stage=plan.nextStage;c.workflow.consentEvidence=plan.consentEvidence;
    c.status='blocked_config';
    if(!state.notifications.some(n=>n.key===`blocked:${cid}:${fingerprint}`))state.notifications.push({key:`blocked:${cid}:${fingerprint}`,type:'configuration_required',conversationId:cid,reason:plan.reason,at:new Date().toISOString()});
  }
  if(['handoff','blocked','wait'].includes(plan.type)){c.processedFingerprint=fingerprint;c.pendingAt=null;}
  return true;
}

export function confirmWorkflowSend(state,cid,plan,intentId) {
  const c=state.conversations[cid];c.workflow??={stage:'screening'};
  c.workflow.stage=plan.nextStage;c.workflow.lastIntentId=intentId;
  if(plan.flowRule){
    const {jobId,id}=plan.flowRule;
    const prior=c.workflow.flowProgress;
    const delivered=prior?.jobId===jobId?prior.delivered:[];
    c.workflow.flowProgress={jobId,delivered:[...new Set([...delivered,id])]};
  }
  if(plan.receiptToken)c.workflow.receiptToken=plan.receiptToken;
  if(plan.emailSubjectFormat)c.workflow.emailSubjectFormat=plan.emailSubjectFormat;
  if(plan.messageId==='S3')delete c.pendingAssessment;
  if(plan.messageId==='S6'){c.clarificationCount=(Number(c.clarificationCount)||0)+1;c.questionsAsked=[...new Set([...(c.questionsAsked||[]),...(plan.questions||[])])];}
  if(plan.messageId==='S7')delete c.pendingAttachmentGuidance;
  if(plan.screening)c.screening=plan.screening;
  c.status=plan.nextStage;c.plan=null;
  const last=(c.messages||[]).findLast(m=>['incoming','outgoing','unknown'].includes(m.direction));
  if(last?.direction==='outgoing'){c.processedFingerprint=c.fingerprint;c.pendingAt=null;}
}
