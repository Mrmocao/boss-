import {readFile,writeFile,mkdir,rename,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {projectRoot} from './config.mjs';
import {loadConfig} from './config.mjs';
import {launchBrowser} from './launcher.mjs';
import {listTargets,isBossUrl,CdpSession} from './cdp.mjs';
import {probeRecruiterTarget} from './browser-registry.mjs';

export const accountsPath=join(projectRoot,'.local','accounts.json');
const root=join(projectRoot,'.runtime','accounts');
const idOk=id=>typeof id==='string'&&/^[a-z0-9][a-z0-9-]{1,48}$/.test(id);
const portOk=port=>Number.isInteger(port)&&port>=19340&&port<=19499;
const baseAccounts=[{id:'company-2',label:'公司招聘账号2',profile:'company-2',port:19335,displayName:'汪女士',enabled:true,managed:true}];
async function read(){try{return JSON.parse(await readFile(accountsPath,'utf8'));}catch(e){if(e.code==='ENOENT')return {version:1,accounts:baseAccounts};throw Object.assign(Error('ACCOUNT_REGISTRY_INVALID'),{code:'ACCOUNT_REGISTRY_INVALID'});}}
async function save(doc){await mkdir(resolve(accountsPath,'..'),{recursive:true});const temp=`${accountsPath}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(doc,null,2)+'\n',{flag:'wx'});try{await rename(temp,accountsPath);}finally{await unlink(temp).catch(()=>{});}}
export async function listAccounts({refresh=true}={}){const doc=await read();const result=[];for(const account of doc.accounts||[]){const current={...account};if(refresh){try{Object.assign(current,await refreshAccount(current));}catch(e){current.status='error';current.error=e.code||'ACCOUNT_CHECK_FAILED';}}result.push(safeAccount(current));}return result;}
export function safeAccount(a){return {id:a.id,label:a.label,profile:a.profile,port:a.port,displayName:a.displayName||null,enabled:a.enabled!==false,managed:a.managed===true,status:a.status||'not_checked',error:a.error||null,lastCheckedAt:a.lastCheckedAt||null,url:a.url||null,targetId:a.targetId||null};}
function configFor(account){const detected=loadConfig({...process.env,BOSS_PROFILE:'company-2'});const runtimeDir=account.managed?join(projectRoot,'.runtime',account.profile):join(root,account.id);return {profile:account.id,port:account.port,endpoint:`http://127.0.0.1:${account.port}`,chromePath:detected.chromePath,runtimeDir,profileDir:resolve(runtimeDir,'chrome-profile')};}
async function targetStatus(account,config){const targets=await listTargets(config.endpoint);const pages=targets.filter(t=>t.type==='page'&&isBossUrl(t.url)&&new URL(t.url).pathname==='/web/chat/index');const verified=[];for(const target of pages){try{const observed=await probeRecruiterTarget(target,config);if(observed.state==='RECRUITER_UI_CONFIRMED'&&observed.recruiter==='ui_confirmed'&&(!account.displayName||observed.accountDisplayName===account.displayName))verified.push({target,observed});}catch{}}
if(verified.length!==1)return {status:verified.length?'ambiguous':'logged_out',error:verified.length?'MULTIPLE_VERIFIED_PAGES':'NO_VERIFIED_RECRUITER_PAGE',url:pages[0]?new URL(pages[0].url).origin+new URL(pages[0].url).pathname:null,targetId:null};
const {target,observed}=verified[0];return {status:'connected',error:null,displayName:observed.accountDisplayName,url:new URL(target.url).origin+new URL(target.url).pathname,targetId:target.id};}
export async function refreshAccount(account){const config=configFor(account);let launch;try{launch=JSON.parse(await readFile(join(config.runtimeDir,'launch.json'),'utf8'));}catch{return {status:'not_started',error:null,lastCheckedAt:new Date().toISOString()};}if(launch.endpoint!==config.endpoint||launch.profileDir!==config.profileDir)return {status:'profile_mismatch',error:'PROFILE_MISMATCH',lastCheckedAt:new Date().toISOString()};try{return {...await targetStatus(account,config),lastCheckedAt:new Date().toISOString()};}catch(e){return {status:'offline',error:e.code||'CDP_UNAVAILABLE',lastCheckedAt:new Date().toISOString()};}}
export async function addAccount(input){const doc=await read();if(!idOk(input?.id)||!input.label?.trim())throw Object.assign(Error('ACCOUNT_INPUT_INVALID'),{code:'ACCOUNT_INPUT_INVALID'});if(doc.accounts.some(a=>a.id===input.id))throw Object.assign(Error('ACCOUNT_EXISTS'),{code:'ACCOUNT_EXISTS'});const used=new Set(doc.accounts.map(a=>a.port));let port=Number(input.port)||19340;while(used.has(port)&&port<19500)port++;if(!portOk(port)||used.has(port))throw Object.assign(Error('ACCOUNT_PORT_INVALID'),{code:'ACCOUNT_PORT_INVALID'});const account={id:input.id,label:String(input.label).trim().slice(0,80),profile:input.id,port,displayName:input.displayName?.trim()||null,enabled:true,managed:false};doc.accounts.push(account);await save(doc);return safeAccount(account);}
export async function updateAccount(id,input){const doc=await read(),account=doc.accounts.find(a=>a.id===id);if(!account)throw Object.assign(Error('ACCOUNT_NOT_FOUND'),{code:'ACCOUNT_NOT_FOUND'});if(input?.label!==undefined&&(!String(input.label).trim()||String(input.label).length>80))throw Object.assign(Error('ACCOUNT_INPUT_INVALID'),{code:'ACCOUNT_INPUT_INVALID'});if(input?.displayName!==undefined&&String(input.displayName).length>80)throw Object.assign(Error('ACCOUNT_INPUT_INVALID'),{code:'ACCOUNT_INPUT_INVALID'});if(input?.label!==undefined)account.label=String(input.label).trim();if(input?.displayName!==undefined)account.displayName=String(input.displayName).trim()||null;await save(doc);return safeAccount(account);}
export async function prepareNewAccount(){const doc=await read(),used=new Set(doc.accounts.map(a=>a.port));let port=19340;while(used.has(port)&&port<19500)port++;if(!portOk(port))throw Object.assign(Error('ACCOUNT_PORT_INVALID'),{code:'ACCOUNT_PORT_INVALID'});let index=doc.accounts.length+1,id=`company-${index}`;while(doc.accounts.some(a=>a.id===id)){index++;id=`company-${index}`;}const account={id,label:`新招聘账号 ${index}`,profile:id,port,displayName:null,enabled:true,managed:false,pendingLogin:true};doc.accounts.push(account);await save(doc);try{return {...await launchAccount(id),account:safeAccount(account)};}catch(e){await save({...doc,accounts:doc.accounts.filter(a=>a.id!==id)});throw e;}}
export async function launchAccount(id){const doc=await read(),account=doc.accounts.find(a=>a.id===id);if(!account)throw Object.assign(Error('ACCOUNT_NOT_FOUND'),{code:'ACCOUNT_NOT_FOUND'});const config=configFor(account);const launched=await launchBrowser(config);await save({...doc,accounts:doc.accounts.map(a=>a.id===id?{...a,status:'login_required',lastCheckedAt:new Date().toISOString()}:a)});return {account:safeAccount(account),...launched};}
export async function refreshAndSaveAccount(id){const doc=await read(),account=doc.accounts.find(a=>a.id===id);if(!account)throw Object.assign(Error('ACCOUNT_NOT_FOUND'),{code:'ACCOUNT_NOT_FOUND'});const result=await refreshAccount(account),next={...account,...result};await save({...doc,accounts:doc.accounts.map(a=>a.id===id?next:a)});return safeAccount(next);}
export async function recoverAccount(id){
 const doc=await read(),account=doc.accounts.find(a=>a.id===id);if(!account)throw Object.assign(Error('ACCOUNT_NOT_FOUND'),{code:'ACCOUNT_NOT_FOUND'});
 const config=configFor(account);let targets;
 try{targets=await listTargets(config.endpoint);}catch{return launchAccount(id);}
 const pages=targets.filter(target=>target.type==='page'&&isBossUrl(target.url));
 const target=pages.find(page=>new URL(page.url).pathname==='/web/chat/index')||pages[0];
 if(!target)return launchAccount(id);
 if(new URL(target.url).pathname!=='/web/chat/index'){
  const session=new CdpSession(target.webSocketDebuggerUrl,{endpoint:config.endpoint});
  try{await session.connect();await session.send('Page.navigate',{url:'https://www.zhipin.com/web/chat/index'});}finally{session.close();}
  return {state:'BROWSER_PAGE_RECOVERED',endpoint:config.endpoint,targetId:target.id};
 }
 return {state:'BROWSER_ALREADY_OPEN',endpoint:config.endpoint,targetId:target.id};
}
