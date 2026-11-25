import {spawn} from 'node:child_process';
import {openSync,closeSync} from 'node:fs';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {projectRoot} from './config.mjs';
import {MonitorStore} from './monitor-store.mjs';
import {monitorRoot,monitorRootForProfile,readStatus,queueCommand,readMonitorConfig} from './monitor-daemon.mjs';
import {startMonitorWeb} from './monitor-web.mjs';
import {startAutomationApi} from './automation-api.mjs';
import {listAccounts,recoverAccount} from './account-manager.mjs';

const root=resolve(projectRoot,'.local/service');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const monitorSelectionPath=resolve(root,'monitor-selection.json');
const monitorConfigDir=resolve(root,'monitor-configs');
const supervisorStopPath=resolve(root,'supervisor-stop');
async function readSelection(defaultProfile){
  try{return JSON.parse(await readFile(monitorSelectionPath,'utf8'));}
  catch(e){if(e.code!=='ENOENT')throw e;return {[defaultProfile]:true};}
}
async function writeSelection(selection){
  await mkdir(root,{recursive:true});
  await writeFile(monitorSelectionPath,JSON.stringify(selection,null,2)+'\n','utf8');
}
async function monitorDefinitions(base){
  const accounts=await listAccounts({refresh:false});
  const definitions=new Map();
  for(const account of accounts){
    if(!['company-2','company-3'].includes(account.profile)||!account.displayName)continue;
    const profile=account.profile;
    definitions.set(profile,{profile,displayName:account.displayName,root:monitorRootForProfile(profile),configPath:resolve(monitorConfigDir,`${profile}.json`),config:{...base,profile,expectedAccountDisplayName:account.displayName}});
  }
  if(!definitions.has(base.profile))definitions.set(base.profile,{profile:base.profile,displayName:base.expectedAccountDisplayName,root:monitorRootForProfile(base.profile),configPath:resolve(monitorConfigDir,`${base.profile}.json`),config:base});
  return definitions;
}
export async function serviceStatus(){
  try {
    const s=JSON.parse(await readFile(resolve(root,'state.json'),'utf8'));
    const owner=JSON.parse(await readFile(resolve(root,'daemon.lock/owner.json'),'utf8'));
    let alive=false;try{process.kill(owner.pid,0);alive=owner.pid===s.runtime.pid;}catch{}
    let supervisor=null;try{supervisor=JSON.parse((await readFile(resolve(root,'supervisor.json'),'utf8')).replace(/^\uFEFF/,''));}catch{}
    if(!alive)return {running:false,status:'stopped',lastHeartbeatAt:s.runtime?.heartbeatAt||null,lastKnownStatus:s.runtime?.status||'unknown',supervisor};
    return {running:true,...s.runtime,responsive:Date.now()-Date.parse(s.runtime.heartbeatAt)<20000,supervisor};
  }catch{return {running:false,status:'stopped'};}
}
export async function runService(){
  const store=await new MonitorStore(root).init();
  let stopping=false,web,automationApi,apiStatus='disabled',mail,lastMail=0;
  const monitors=new Map(),lastLaunch=new Map(),stopRequested=new Set();
  const browserRecovery=new Map();
  const signal=()=>{stopping=true;};process.on('SIGTERM',signal);process.on('SIGINT',signal);
  const launch=(file,args,label)=>{
    const out=openSync(resolve(root,label+'.stdout.log'),'a'),err=openSync(resolve(root,label+'.stderr.log'),'a');
    try{const child=spawn(file,args,{cwd:projectRoot,windowsHide:true,stdio:['ignore',out,err]});child.on('error',()=>{});return child;}finally{closeSync(out);closeSync(err);}
  };
  try{
    await unlink(resolve(root,'stop')).catch(()=>{});
    const config=await readMonitorConfig();
    const definitions=await monitorDefinitions(config);
    let selection=await readSelection(config.profile);
    await writeSelection({...selection,[config.profile]:selection[config.profile]!==false});
    for(const definition of definitions.values())await mkdir(resolve(definition.configPath,'..'),{recursive:true});
    const monitorRoots=Object.fromEntries([...definitions].map(([profile,definition])=>[profile,definition.root]));
    const monitorStatus=async()=>{
      const currentSelection=await readSelection(config.profile),items=[];
      for(const definition of definitions.values()){
        const status=await readStatus(definition.root);
        items.push({profile:definition.profile,displayName:definition.displayName,selected:currentSelection[definition.profile]===true,running:status.running,responsive:status.responsive,health:status.runtime?.health||'not_started',lastError:status.runtime?.lastError||null,heartbeatAt:status.runtime?.heartbeatAt||null,recovery:browserRecovery.get(definition.profile)||null,root:definition.root});
      }
      return items;
    };
    const setMonitor=async(profile,action)=>{
      const definition=definitions.get(profile);if(!definition)throw Object.assign(new Error('Unknown monitor profile'),{code:'MONITOR_PROFILE_UNKNOWN'});
      selection=await readSelection(config.profile);
      if(action==='start'||action==='stop'){
        selection[profile]=action==='start';await writeSelection(selection);
        if(action==='stop')await queueCommand('stop',undefined,definition.root).catch(e=>{if(e.code!=='MONITOR_OFFLINE')throw e;});
      }else if(action==='pause'||action==='resume')await queueCommand(action,undefined,definition.root);
      else throw Object.assign(new Error('Unknown monitor action'),{code:'MONITOR_ACTION_INVALID'});
      return (await monitorStatus()).find(item=>item.profile===profile);
    };
    web=await startMonitorWeb({root:monitorRoot,monitorRoots,monitorControl:{status:monitorStatus,set:setMonitor}});
    try{automationApi=await startAutomationApi({monitorRoot,serviceRoot:root});apiStatus=automationApi?'listening':'disabled';}catch(e){apiStatus=e.code==='AUTOMATION_CONFIG_INVALID'?'not_configured':'unavailable';}
    await store.transaction(s=>{s.runtime={pid:process.pid,status:'starting',startedAt:new Date().toISOString(),heartbeatAt:new Date().toISOString()};});
    while(!stopping){
      try{await readFile(resolve(root,'stop'));stopping=true;continue;}catch{}
      selection=await readSelection(config.profile);
      for(const definition of definitions.values()){
        const child=monitors.get(definition.profile),live=child&&child.exitCode===null&&!child.signalCode;
        const status=await readStatus(definition.root);
        if(selection[definition.profile]===true){
          const recoveryDue=Date.now()-(browserRecovery.get(definition.profile)?.attemptedAt||0)>30000;
          if(recoveryDue&&(!status.running||status.runtime?.health==='disconnected'||status.runtime?.lastError)){
            const recovery={attemptedAt:Date.now(),state:'recovering',error:null};browserRecovery.set(definition.profile,recovery);
            try{const account=(await listAccounts({refresh:false})).find(item=>item.profile===definition.profile);if(account){const result=await recoverAccount(account.id);browserRecovery.set(definition.profile,{...recovery,...result,state:'recovery_requested'});}else browserRecovery.set(definition.profile,{...recovery,state:'account_missing',error:'ACCOUNT_NOT_REGISTERED'});}catch(e){browserRecovery.set(definition.profile,{...recovery,state:'recovery_failed',error:e.code||'BROWSER_RECOVERY_FAILED'});}
          }
          if(!live&&!status.running&&Date.now()-(lastLaunch.get(definition.profile)||0)>5000){
            await writeFile(definition.configPath,JSON.stringify(definition.config,null,2)+'\n','utf8');
            monitors.set(definition.profile,launch(process.execPath,[resolve(projectRoot,'src/monitor-daemon.mjs'),'run','--profile',definition.profile,'--root',definition.root,'--config',definition.configPath],`monitor-${definition.profile}`));
            lastLaunch.set(definition.profile,Date.now());stopRequested.delete(definition.profile);
          }
        }else if(status.running&&!stopRequested.has(definition.profile)){
          await queueCommand('stop',undefined,definition.root).catch(e=>{if(e.code!=='MONITOR_OFFLINE')throw e;});stopRequested.add(definition.profile);
        }
      }
      if((!mail||mail.exitCode!==null||mail.signalCode)&&Date.now()-lastMail>60000){
        mail=launch(resolve(projectRoot,'../.tools/python/python.exe'),['-X','utf8',resolve(projectRoot,'scripts/mail_worker.py'),'--config',config.model.configFile,'--root',resolve(projectRoot,'.local/mail')],'mail');lastMail=Date.now();
      }
      const current=await readStatus(monitorRoot),profiles=await monitorStatus();
      await store.transaction(s=>{s.runtime={...s.runtime,status:'running',heartbeatAt:new Date().toISOString(),monitorRunning:current.running,monitorHealth:current.runtime?.health,monitorProfiles:profiles,webUrl:'http://127.0.0.1:19336/',automationApiStatus:apiStatus,mailWorkerPid:mail?.pid};});
      await delay(2000);
    }
  }finally{
    for(const definition of (await monitorDefinitions(await readMonitorConfig())).values()){
      await queueCommand('stop',undefined,definition.root).catch(()=>{});
      for(let i=0;i<20&&(await readStatus(definition.root)).running;i++)await delay(1000);
    }
    if(mail&&mail.exitCode===null)mail.kill();
    await new Promise(r=>web?web.close(r):r());
    await new Promise(r=>automationApi?automationApi.close(r):r());
    await store.transaction(s=>{s.runtime.status='stopped';s.runtime.stoppedAt=new Date().toISOString();});await store.close();
    process.off('SIGTERM',signal);process.off('SIGINT',signal);
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const command=process.argv[2]||'status';
  try{
    if(command==='run')await runService();
    else if(command==='status')console.log(JSON.stringify(await serviceStatus(),null,2));
    else if(command==='stop'){await mkdir(root,{recursive:true});await writeFile(supervisorStopPath,'stop');const s=await serviceStatus();if(s.running){await writeFile(resolve(root,'stop'),'stop');for(let i=0;i<25&&(await serviceStatus()).running;i++)await delay(1000);}console.log(JSON.stringify(await serviceStatus(),null,2));}
    else throw new Error('Unknown service command');
  }catch(e){console.error(JSON.stringify({code:e.code||'SERVICE_FAILED',message:e.code==='MONITOR_ALREADY_RUNNING'?e.message:'服务启动失败，请查看本地日志'}));process.exitCode=1;}
}
