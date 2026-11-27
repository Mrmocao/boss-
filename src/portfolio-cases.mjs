import {mkdir,readFile,readdir,unlink,writeFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {renameWithRetry} from './monitor-store.mjs';
import {portfolioError,portfolioTemplates,screenPortfolio} from './portfolio-workflow.mjs';

const afterSend = {S2:'已引导投递',S3:'婉拒-学历',S4:'婉拒-专业',S5:'已追问'};
const screening = new Set(['待判定','已追问']);
const terminal = new Set(['婉拒-学历','婉拒-专业','关闭']);
const queues = new Map();
function string(value,max,required=false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) portfolioError('INVALID_PORTFOLIO_INPUT');
  return value.trim();
}
function requireState(ok) {if (!ok) portfolioError('PORTFOLIO_STATE_CHANGED');}
function handoff(record,reason) {
  if (record.stage !== '转人工') record.resumeStage = record.stage;
  record.stage = '转人工';
  record.pending = null;
  record.note = reason;
}
function draft(record,step,note,job) {
  record.pending = {step,text:portfolioTemplates(job.prompt)[step]};
  record.note = note;
}
async function transition(record,job,input,analyze) {
  switch (input.action) {
    case 'create': return;
    case 'analyze': {
      requireState(!terminal.has(record.stage) && record.stage !== '转人工' && record.pending?.step !== 'S6');
      record.sources = Object.fromEntries(['chat','profile','resume'].map(key=>[key,string(input.sources?.[key] ?? '',6000)]));
      record.pending = null;
      let facts;
      try {
        facts = Object.values(record.sources).some(Boolean) ? await analyze(job,record.sources) : {};
      } catch {
        record.facts = {};
        return handoff(record,'资料已保存，模型服务或证据校验未通过，请人工核实或恢复后重试。');
      }
      record.facts = facts;
      if (facts.concern) return handoff(record,facts.concern.value+' · '+facts.concern.quote);
      if (facts.attachment) {
        delete record.beforeAttachment;
        return draft(record,'S6','请在 BOSS 拒绝附件，再复制并发送邮箱引导。',job);
      }
      if (!screening.has(record.stage)) {
        record.note='已记录补充资料，继续当前阶段。';
        return;
      }
      const {step,note} = screenPortfolio(job,facts,record.asked);
      if (step === 'S7') return handoff(record,note);
      record.note = note;
      if (step !== 'wait') draft(record,step,note,job);
      if (step === 'S5') {
        const missing = [!facts.enrollment && '目前是否在读', !facts.year && '预计毕业年份'].filter(Boolean);
        if (missing.length) record.pending.text += '也请补充'+missing.join('和')+'。';
      }
      return;
    }
    case 'sent':
      requireState(record.pending && record.pending.step === input.step);
      if (input.step === 'S5') record.asked = true;
      record.stage = afterSend[input.step] || record.stage;
      record.pending = input.step === 'S6' ? record.beforeAttachment || null : null;
      delete record.beforeAttachment;
      record.note = '已人工登记 ' + input.step;
      return;
    case 'attachment':
      if (terminal.has(record.stage)) {
        record.note = '请在 BOSS 拒绝附件，仅拒绝，不再回复。';
      } else {
        if (record.pending?.step !== 'S6') record.beforeAttachment = record.pending;
        draft(record,'S6','请在 BOSS 拒绝附件，再复制并发送邮箱引导。',job);
      }
      return;
    case 'handoff':
      requireState(!terminal.has(record.stage));
      return handoff(record,string(input.reason,600,true));
    case 'resolve':
      requireState(record.stage === '转人工' && screening.has(record.resumeStage) && ['S2','S3','S4'].includes(input.step));
      record.stage = record.resumeStage;
      draft(record,input.step,'人工复核：'+string(input.reason,600,true),job);
      return;
    case 'resume':
      requireState(record.stage === '转人工');
      record.stage = record.resumeStage;
      record.pending = null;
      record.note = '人工核实完成，已恢复原阶段。';
      return;
    case 'receipt':
      requireState(record.stage === '已引导投递' && input.resume === true && input.portfolio === true);
      record.pending = null;
      record.stage = '待批改';
      record.note = '【通知人工】已核对邮箱中的简历和作品集，请安排批阅。';
      return;
    case 'review':
      requireState(record.stage === '待批改');
      record.pending = null;
      record.stage = '已批改';
      record.note = '人工已完成批改。';
      return;
    case 'close':
      requireState(record.stage === '已批改');
      record.pending = null;
      record.stage = '关闭';
      record.note = '跟进已结束。';
      return;
    default: portfolioError('INVALID_PORTFOLIO_INPUT');
  }
}

export async function listPortfolioCases(root,jobId) {
  let names;
  try {names=await readdir(root);} catch(e) {if(e.code==='ENOENT') return [];throw e;}
  const rows = await Promise.all(names.filter(n=>/^[0-9a-f]{64}\.json$/.test(n)).map(async name=>JSON.parse(await readFile(join(root,name),'utf8'))));
  return rows.filter(row=>row.jobId===jobId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
}

export async function updatePortfolioCase(root,job,input,analyze) {
  let id = input.id;
  if (input.action === 'create') {
    const account=string(input.account,100,true), reference=string(input.reference,120,true);
    id = createHash('sha256').update(JSON.stringify([job.id,account,reference])).digest('hex');
  }
  if (typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) portfolioError('INVALID_PORTFOLIO_INPUT');
  const path = join(root,id+'.json');
  const next = (queues.get(path)||Promise.resolve()).catch(()=>{}).then(async()=>{
    let row;
    try {row=JSON.parse(await readFile(path,'utf8'));} catch(e) {if(e.code!=='ENOENT') throw e;}
    if (input.action==='create') {
      if (row) return row;
      row={id,jobId:job.id,account:input.account.trim(),reference:input.reference.trim(),name:string(input.name,100,true),
        stage:'待判定',asked:false,revision:0,sources:{},facts:{},pending:null,note:'已接入，请录入候选人资料。',history:[]};
    } else {
      requireState(row && row.jobId===job.id && row.revision===input.revision);
    }
    await transition(row,job,input,analyze);
    row.updatedAt=new Date().toISOString();
    row.revision++;
    row.history.push({at:row.updatedAt,action:input.action,step:input.step,stage:row.stage,note:row.note});
    await mkdir(root,{recursive:true});
    const temp=path+'.'+randomUUID()+'.tmp';
    try {await writeFile(temp,JSON.stringify(row),{flag:'wx'});await renameWithRetry(temp,path);}
    finally {await unlink(temp).catch(()=>{});}
    return row;
  });
  queues.set(path,next);
  try {return await next;} finally {if(queues.get(path)===next) queues.delete(path);}
}
