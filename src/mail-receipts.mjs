import {readFile} from 'node:fs/promises';
import {resolve,relative,isAbsolute} from 'node:path';
import {projectRoot} from './config.mjs';

export function applyMailReceipt(state,mail) {
  state.mailReceipts??={};
  if(!mail?.id||state.mailReceipts[mail.id])return false;
  state.mailReceipts[mail.id]={id:mail.id,mailboxId:mail.mailboxId,observedAt:mail.observedAt};
  const subject=mail.submissionSubject;
  const matches=Object.values(state.conversations).filter(c=>mail.token?c.workflow?.receiptToken===mail.token:
    subject&&c.name?.trim()===subject.name?.trim()&&c.jobTitle?.trim()===subject.jobTitle?.trim()
      &&Object.values(state.sentIntents||{}).some(i=>i.conversationId===c.id&&i.messageId==='S3'&&i.status==='sent_confirmed'));
  const c=matches.length===1?matches[0]:null;
  const s3=Object.values(state.sentIntents||{}).find(i=>i.conversationId===c?.id&&i.messageId==='S3'&&i.status==='sent_confirmed');
  const mailDate=Number.isFinite(Date.parse(mail.date))?new Date(Date.parse(mail.date)+8*3600000).toISOString().slice(0,10):null;
  const reason=mail.reviewReason||(matches.length>1?'同名同岗位存在多个会话，请人工核对':!c||!s3?'邮件无法关联已发题会话':
    !mail.token&&(!subject?.date||subject.date!==mailDate)?'邮件主题提交日期与邮件日期不符，请人工核对':
    !['waiting_email','submission_incomplete'].includes(c.workflow.stage)?'会话不在等待收件阶段':
    mail.recipient!=='hr-rpg@youkia.net'?'收件邮箱不一致':
    !Number.isFinite(Date.parse(mail.date))||!Number.isFinite(Date.parse(s3.receipt?.observedAt||s3.createdAt))||Date.parse(mail.date)<Date.parse(s3.receipt?.observedAt||s3.createdAt)?'邮件时间早于发题或时间缺失':
    c.submission?.sender&&c.submission.sender!==mail.sender?'两封材料发件人不一致':null);
  if(reason){state.notifications.push({type:'mail_review',conversationId:c?.id,reason,at:new Date().toISOString()});return false;}
  c.submission??={sender:mail.sender,attachments:[],receiptIds:[]};
  c.submission.receiptIds.push(mail.id);
  for(const file of mail.attachments||[])if(!c.submission.attachments.some(f=>f.sha256===file.sha256))c.submission.attachments.push(file);
  const q=c.submission.attachments.find(f=>f.role==='questionnaire');
  const resume=c.submission.attachments.find(f=>f.role==='resume'&&f.sha256!==q?.sha256);
  const complete=!!(q&&resume);
  c.workflow.stage=complete?'awaiting_review':'submission_incomplete';c.status=c.workflow.stage;
  c.submission.materialsReceived=complete;c.submission.identityBasis=mail.token?'legacy_receipt_token_and_consistent_sender':'unique_name_job_submission_date_and_consistent_sender';
  c.submission.contentGraded=false;
  state.notifications.push({type:complete?'submission_complete':'submission_incomplete',conversationId:c.id,reason:complete?'问卷与简历已收到，待批改（尚未评阅内容）':'材料不齐或文件类型无法识别，待补齐',at:new Date().toISOString()});
  return complete;
}

export async function consumeMailbox(store,root=resolve(projectRoot,'.local/mail')) {
  let status;
  try{status=JSON.parse(await readFile(resolve(root,'status.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return;throw e;}
  for(const a of status.accounts||[]) {
    if(a.status!=='connected'||!a.receiptsFile)continue;
    const path=resolve(a.receiptsFile),rel=relative(root,path);
    if(rel.startsWith('..')||isAbsolute(rel))continue;
    const receipts=JSON.parse(await readFile(path,'utf8'));
    await store.transaction(s=>{for(const receipt of receipts)applyMailReceipt(s,receipt);s.runtime.mailbox={checkedAt:status.checkedAt,accounts:status.accounts.map(x=>({id:x.id,status:x.status,error:x.error})),status:status.accounts.some(x=>x.status==='connected')?'connected':'awaiting_configuration'};});
  }
  if(!(status.accounts||[]).some(x=>x.status==='connected'))await store.transaction(s=>{s.runtime.mailbox={checkedAt:status.checkedAt,status:'awaiting_configuration',accounts:status.accounts};});
}
