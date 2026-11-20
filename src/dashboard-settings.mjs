import {readFile,writeFile,unlink} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {projectRoot} from './config.mjs';
import {renameWithRetry} from './monitor-store.mjs';
import {questionnaireUrl,questionnaireExpiresAt} from './recruiting-workflow.mjs';
import {verifyAssessmentDownload} from './service-sender.mjs';

export const assessmentRevision=a=>createHash('sha256').update(JSON.stringify({delivery:a?.delivery||'file',url:a?.url||'',filePath:a?.filePath||'',updatedAt:a?.updatedAt||null})).digest('hex');
export async function resolveSkillConfig(){const m=JSON.parse(await readFile(resolve(projectRoot,'config/monitor.json'),'utf8'));return resolve(projectRoot,m.model.configFile);}
const fail=code=>{throw Object.assign(new Error(code),{code});};
async function read(path){try{return JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));}catch{fail('SETTINGS_READ_FAILED');}}
export async function readDashboardSettings(path){
 const c=await read(path),a=c.assessment||{};
 return {revision:assessmentRevision(a),assessment:{delivery:a.delivery||'file',url:a.url||'',fileName:a.filePath?.split(/[\\/]/).at(-1)||null,expiresAt:questionnaireExpiresAt({assessment:a}),usable:!!questionnaireUrl({assessment:a}),updatedAt:a.updatedAt||null},
  mailboxes:(c.mailboxes||[]).map(m=>({id:m.id,address:m.address,enabled:m.enabled===true,hostConfigured:!!m.host,passwordConfigured:!!m.password})),
  model:{enabled:c.model?.enabled===true,configured:!!(c.model?.baseUrl&&c.model?.name&&c.model?.apiKey)}};
}
const queues=new Map();
export async function saveAssessmentSettings(path,input,{verify=verifyAssessmentDownload}={}){
 const previous=queues.get(path)||Promise.resolve();
 const task=previous.catch(()=>{}).then(async()=>{
  if(!input||typeof input.url!=='string'||input.url.length>6000||typeof input.revision!=='string'||Object.keys(input).some(k=>!['url','revision'].includes(k)))fail('INVALID_ASSESSMENT_SETTINGS');
  const original=await read(path);if(assessmentRevision(original.assessment)!==input.revision)fail('SETTINGS_CHANGED');
  const url=input.url.trim().replace(/\\&/g,'&');let parsed;try{parsed=new URL(url);}catch{fail('INVALID_ASSESSMENT_URL');}
  // This local form validates downloads, so it accepts only the observed company host.
  if(parsed.hostname!=='hr-youkia.youkia.net'||parsed.port||!parsed.pathname.endsWith('.xlsx')||!questionnaireUrl({assessment:{url}}))fail('INVALID_OR_EXPIRED_ASSESSMENT_URL');
  const verified=await verify({assessment:{url}});
  const latest=await read(path);if(assessmentRevision(latest.assessment)!==input.revision)fail('SETTINGS_CHANGED');
  latest.assessment={...latest.assessment,delivery:'link',url,updatedAt:new Date().toISOString()};
  const tmp=resolve(dirname(path),`.assessment-${randomUUID()}.tmp`);
  try{await writeFile(tmp,JSON.stringify(latest,null,2)+'\n',{flag:'wx'});await renameWithRetry(tmp,path);}finally{await unlink(tmp).catch(()=>{});}
  return {...await readDashboardSettings(path),validation:{bytes:verified.bytes,sha256:verified.sha256},saved:true};
 });queues.set(path,task);try{return await task;}finally{if(queues.get(path)===task)queues.delete(path);}
}
