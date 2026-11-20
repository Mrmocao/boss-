import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {projectRoot} from './config.mjs';
import {renameWithRetry} from './monitor-store.mjs';
import {loadWorkflowPolicy,questionnaireUrl} from './recruiting-workflow.mjs';
import {verifyAssessmentDownload} from './service-sender.mjs';

export const jobProfilesPath=resolve(projectRoot,'.local/job-profiles.json');
const fail=code=>{throw Object.assign(Error(code),{code});};
const hash=jobs=>createHash('sha256').update(JSON.stringify(jobs)).digest('hex');
const levels=['本科','硕士','博士','大专','专科','高中'];
let initial;
async function initialJobs(){
  const policy=await loadWorkflowPolicy();
  const monitor=JSON.parse(await readFile(resolve(projectRoot,'config/monitor.json'),'utf8'));
  const rules=policy.rules.screening.rules;
  const major=rules.find(r=>r.id==='H2');
  return monitor.acceptedTitles.map((name,i)=>({
    id:'job-'+(i+1),name,acceptedTitles:[name],
    education:rules.find(r=>r.id==='H1').accepted_levels,senior:true,
    majors:Object.values(major.whitelist).flat(),excluded:major.explicit_excluded_categories,
    intent:'游戏策划',requirements:'',prompt:'',url:'',
    onPass:'questionnaire',onMissing:'clarify',onFail:'reject'
  }));
}

export async function readJobProfiles(path=jobProfilesPath){
  let jobs;
  try{jobs=JSON.parse(await readFile(path,'utf8')).jobs;}
  catch(e){
    if(e.code!=='ENOENT')throw e;
    initial??=initialJobs().catch(error=>{initial=null;throw error;});
    jobs=await initial;
  }
  return {revision:hash(jobs),jobs};
}

function field(value,max,required=false){
  if(typeof value!=='string'||value.length>max||(required&&!value.trim()))fail('INVALID_JOB_PROFILE');
  return value.trim();
}
function list(value,max){
  if(!Array.isArray(value)||value.length>max)fail('INVALID_JOB_PROFILE');
  return [...new Set(value.map(item=>field(item,100,true)))];
}
function clean(job){
  if(!job)fail('INVALID_JOB_PROFILE');
  const id=field(job.id,64,true);
  if(!/^[a-z0-9-]+$/.test(id)||typeof job.senior!=='boolean')fail('INVALID_JOB_PROFILE');
  const acceptedTitles=list(job.acceptedTitles,50),education=list(job.education,levels.length);
  if(!acceptedTitles.length||!education.length||education.some(v=>!levels.includes(v)))fail('INVALID_JOB_EDUCATION_OR_TITLE');
  if(!['questionnaire','human'].includes(job.onPass)||!['clarify','human'].includes(job.onMissing)||!['reject','human'].includes(job.onFail))fail('INVALID_JOB_PROFILE');
  const majors=list(job.majors,300),excluded=list(job.excluded,300);
  if(majors.some(v=>excluded.includes(v)))fail('CONFLICTING_MAJORS');
  return {id,name:field(job.name,80,true),acceptedTitles,education,senior:job.senior,majors,excluded,intent:field(job.intent,100),requirements:field(job.requirements,6000),prompt:field(job.prompt,6000),url:field(job.url,6000),onPass:job.onPass,onMissing:job.onMissing,onFail:job.onFail};
}

const saves=new Map();
export async function saveJobProfiles(path,input,{verify=verifyAssessmentDownload}={}){
  const prior=saves.get(path)||Promise.resolve();
  const task=prior.catch(()=>{}).then(async()=>{
    const current=await readJobProfiles(path);
    if(input?.revision!==current.revision)fail('SETTINGS_CHANGED');
    const job=clean(input.job);
    if(current.jobs.some(other=>other.id!==job.id&&other.acceptedTitles.some(title=>job.acceptedTitles.includes(title))))fail('JOB_TITLE_IN_USE');
    const index=current.jobs.findIndex(other=>other.id===job.id);
    if(job.url&&job.url!==current.jobs[index]?.url){
      let link;
      try{link=new URL(job.url);}catch{fail('INVALID_OR_EXPIRED_ASSESSMENT_URL');}
      if(link.hostname!=='hr-youkia.youkia.net'||link.port||!link.pathname.endsWith('.xlsx')||!questionnaireUrl({assessment:{url:job.url}}))fail('INVALID_OR_EXPIRED_ASSESSMENT_URL');
      await verify({assessment:{url:job.url}});
    }
    const jobs=[...current.jobs];
    if(index<0)jobs.push(job);else jobs[index]=job;
    await mkdir(dirname(path),{recursive:true});
    const temp=path+'.'+randomUUID()+'.tmp';
    try{
      await writeFile(temp,JSON.stringify({jobs},null,2)+'\n',{flag:'wx'});
      await renameWithRetry(temp,path);
    }finally{await unlink(temp).catch(()=>{});}
    return {saved:true,jobs,revision:hash(jobs)};
  });
  saves.set(path,task);
  try{return await task;}finally{if(saves.get(path)===task)saves.delete(path);}
}

export function contextForJob(config,policy,title){
  const job=config.jobProfiles?.jobs.find(item=>item.acceptedTitles.includes(title));
  if(!job)return {config,policy};
  const workflow={...config.workflow,requirements:job.requirements||config.workflow?.requirements,prompt:job.prompt||config.workflow?.prompt};
  return {config:{...config,workflow,assessment:job.url?{...config.assessment,delivery:'link',url:job.url}:config.assessment},policy:{...policy,job}};
}
