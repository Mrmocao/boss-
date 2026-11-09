import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CdpSession, ConnectorError, isBossUrl, listTargets } from './cdp.mjs';
import { loadConfig, profilePorts } from './config.mjs';
import { classifyPage, pageProbe } from './page-status.mjs';

const chatPage = target => target?.type === 'page' && isBossUrl(target.url)
  && new URL(target.url).pathname === '/web/chat/index';
const safeUrl = value => new URL(value).origin + new URL(value).pathname;
const fail = (code, message, extra = {}) => { throw Object.assign(new ConnectorError(code,message),extra); };
const depsFor = deps => ({readFile,writeFile,rename,mkdir,unlink,listTargets,probeTarget:probeRecruiterTarget,loadConfig,...deps});

// This reads visible DOM only. No tokens, cookies, localStorage or platform APIs are used.
const identityProbe = `(() => {
  const page = ${pageProbe};
  if (page.blocked) return {blocked:true};
  const profile = document.querySelector('.top-profile-logout .user-name');
  return {url:page.url, signals:page.signals, ready:page.ready,
    accountDisplayName:profile?.innerText?.trim() || null};
})()`;

export async function probeRecruiterTarget(target, config) {
  if (!chatPage(target)) fail('NOT_RECRUITER_CHAT','Target is not the recruiter conversation page.');
  const session = new CdpSession(target.webSocketDebuggerUrl,{endpoint:config.endpoint});
  try {
    await session.connect();
    const before = await session.send('Target.getTargetInfo',{targetId:target.id});
    if (!chatPage({type:'page',url:before.targetInfo?.url})) fail('TARGET_CHANGED','Target changed before account verification.');
    const read = async () => {
      const result = await session.send('Runtime.evaluate',{expression:identityProbe,returnByValue:true,timeout:4000});
      const value = result.result?.value;
      if (result.exceptionDetails || !value || value.blocked || !isBossUrl(value.url)) fail('PAGE_READ_FAILED','Cannot verify recruiter account from the current page.');
      return value;
    };
    const first = await read();
    const second = await read();
    const after = await session.send('Target.getTargetInfo',{targetId:target.id});
    if (before.targetInfo.url !== first.url || first.url !== second.url || second.url !== after.targetInfo?.url
      || first.accountDisplayName !== second.accountDisplayName || JSON.stringify(first.signals) !== JSON.stringify(second.signals))
      fail('TARGET_CHANGED','Account or page changed during verification.');
    const classified = classifyPage({...second,text:''});
    return {state:classified.state, recruiter:classified.recruiter,
      accountDisplayName:second.accountDisplayName, url:safeUrl(second.url), identityConfidence:'display_only'};
  } finally { session.close(); }
}

async function readBinding(config,deps) {
  let value;
  try { value=JSON.parse(await deps.readFile(join(config.runtimeDir,'browser-binding.json'),'utf8')); }
  catch (error) {
    if (error.code==='ENOENT') return null;
    fail('BROWSER_BINDING_INVALID','Saved browser binding cannot be read.');
  }
  if (!value || value.schemaVersion!==1 || value.profile!==config.profile || value.endpoint!==config.endpoint
    || value.profileDir!==config.profileDir || typeof value.targetId!=='string' || !value.targetId
    || typeof value.accountDisplayName!=='string' || !value.accountDisplayName
    || !isBossUrl(value.url) || new URL(value.url).pathname!=='/web/chat/index')
    fail('BROWSER_BINDING_INVALID','Saved browser binding does not match this dedicated profile.');
  return value;
}

async function verifyLaunch(config,deps) {
  let launch;
  try { launch=JSON.parse(await deps.readFile(join(config.runtimeDir,'launch.json'),'utf8')); }
  catch { fail('PROFILE_CONNECTION_UNVERIFIED','No readable launch record for this dedicated profile.'); }
  if (launch.profile!==config.profile || launch.endpoint!==config.endpoint || launch.profileDir!==config.profileDir)
    fail('PROFILE_CONNECTION_UNVERIFIED','Launch record does not match this dedicated profile and endpoint.');
  return launch;
}

async function saveBinding(config,target,observed,deps) {
  const binding = {schemaVersion:1,profile:config.profile,endpoint:config.endpoint,profileDir:config.profileDir,
    targetId:target.id,url:safeUrl(target.url),accountDisplayName:observed.accountDisplayName,
    identityConfidence:'display_only',checkedAt:new Date().toISOString()};
  const bindingPath=join(config.runtimeDir,'browser-binding.json');
  const temp=`${bindingPath}.${randomUUID()}.tmp`;
  await deps.mkdir(config.runtimeDir,{recursive:true});
  try {
    await deps.writeFile(temp,JSON.stringify(binding,null,2)+'\n',{encoding:'utf8',flag:'wx'});
    await deps.rename(temp,bindingPath);
  } catch (error) { await deps.unlink(temp).catch(()=>{}); throw error; }
  return {target,binding,bindingPath};
}

/** Find a verified recruiter tab within one explicitly isolated browser profile. */
export async function resolveRecruiterTarget({config,expectedAccountDisplayName,targetId},dependencies={}) {
  const deps=depsFor(dependencies);
  if (!config || !Object.hasOwn(profilePorts,config.profile)) fail('INVALID_PROFILE','A known dedicated profile is required.');
  if (expectedAccountDisplayName!==undefined && (typeof expectedAccountDisplayName!=='string' || !expectedAccountDisplayName.trim()))
    fail('ACCOUNT_REQUIRED','Expected account display name must be non-empty.');
  if (targetId!==undefined && (typeof targetId!=='string' || !targetId)) fail('INVALID_TARGET_ID','Target id must be non-empty.');
  await verifyLaunch(config,deps);
  const saved=await readBinding(config,deps);
  const expected=expectedAccountDisplayName || saved?.accountDisplayName;
  // A changed account binding must be deliberate, rather than silently adopting another account.
  if (saved && expectedAccountDisplayName && saved.accountDisplayName!==expectedAccountDisplayName)
    fail('ACCOUNT_BINDING_MISMATCH','Saved account differs from the explicitly expected account.');
  const candidates=(await deps.listTargets(config.endpoint)).filter(chatPage);
  const inspect=async target => {
    const observed=await deps.probeTarget(target,config);
    if (observed.state!=='RECRUITER_UI_CONFIRMED' || observed.recruiter!=='ui_confirmed' || !observed.accountDisplayName)
      fail('RECRUITER_ACCOUNT_UNVERIFIED','Recruiter login is not verified for this tab.');
    if (expected && observed.accountDisplayName!==expected) fail('ACCOUNT_CHANGED','Recruiter account does not match the saved account.');
    return observed;
  };
  if (targetId) {
    const explicit=candidates.find(t=>t.id===targetId);
    if (!explicit) fail('TARGET_NOT_ALLOWED','Requested recruiter target is missing or has changed page.');
    return saveBinding(config,explicit,await inspect(explicit),deps);
  }
  const remembered=candidates.find(t=>t.id===saved?.targetId);
  if (remembered) {
    try { return await saveBinding(config,remembered,await inspect(remembered),deps); }
    catch (error) {
      // Wrong account in the recorded tab must not be concealed by selecting another tab.
      if (error.code==='ACCOUNT_CHANGED') throw error;
      if (!['TARGET_CHANGED','PAGE_READ_FAILED','RECRUITER_ACCOUNT_UNVERIFIED','CDP_CLOSED','CDP_UNAVAILABLE','CDP_CONNECT_TIMEOUT','CDP_CONNECTION_ERROR'].includes(error.code)) throw error;
    }
  }
  const verified=[]; const failures=[];
  for (const target of candidates) {
    try { verified.push({target,observed:await inspect(target)}); }
    catch (error) { failures.push({targetId:target.id,code:error.code || 'PAGE_READ_FAILED'}); }
  }
  if (verified.length>1) fail('AMBIGUOUS_RECRUITER_TARGET','Multiple verified recruiter tabs exist; select a target id once to save the binding.',
    {targets:verified.map(({target})=>({targetId:target.id,url:safeUrl(target.url)}))});
  if (!verified.length) fail('NO_VERIFIED_RECRUITER_TARGET','No matching signed-in recruiter conversation tab was found.',{targets:failures});
  return saveBinding(config,verified[0].target,verified[0].observed,deps);
}

/** Inventory only known dedicated profiles. Other browser processes and websites are not scanned. */
export async function listKnownBossBrowsers({env=process.env}={},dependencies={}) {
  const deps=depsFor(dependencies); const browsers=[];
  for (const profile of Object.keys(profilePorts)) {
    let config; let row={profile,status:'unavailable'};
    try {
      // Start at the known profile directory, then honor its recorded local endpoint port.
      const cleanEnv={...env,BOSS_PROFILE:profile}; delete cleanEnv.BOSS_CDP_PORT;
      config=deps.loadConfig(cleanEnv);
      let launch;
      try { launch=JSON.parse(await deps.readFile(join(config.runtimeDir,'launch.json'),'utf8')); }
      catch { row.status='not_registered'; browsers.push(row); continue; }
      const port=/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/?$/.exec(launch.endpoint || '')?.[1];
      if (!port) fail('PROFILE_CONNECTION_UNVERIFIED','Recorded endpoint is not canonical loopback.');
      config=deps.loadConfig({...cleanEnv,BOSS_CDP_PORT:port});
      await verifyLaunch(config,deps);
      row.endpoint=config.endpoint; row.profileDir=config.profileDir;
      row.binding=await readBinding(config,deps);
      const targets=await deps.listTargets(config.endpoint);
      row.pages=[];
      for (const target of targets.filter(t=>t.type==='page' && isBossUrl(t.url))) {
        const page={targetId:target.id,url:safeUrl(target.url),state:'boss_page'};
        if (chatPage(target)) {
          try { const observation=await deps.probeTarget(target,config);
            page.state=observation.state; page.accountDisplayName=observation.accountDisplayName;
            page.identityConfidence='display_only'; }
          catch (error) { page.state=error.code || 'PAGE_READ_FAILED'; }
        }
        row.pages.push(page);
      }
      row.status='connected';
    } catch (error) { row.status=error.code || 'DISCOVERY_FAILED'; }
    browsers.push(row);
  }
  return {checkedAt:new Date().toISOString(),browsers,sendsMessages:false};
}
