import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveRecruiterTarget,listKnownBossBrowsers} from '../src/browser-registry.mjs';

const tab=(id,url='https://www.zhipin.com/web/chat/index?private=value')=>({id,type:'page',url,webSocketDebuggerUrl:`ws://127.0.0.1:19335/devtools/page/${id}`});
const observed=(name='汪女士',state='RECRUITER_UI_CONFIRMED')=>({state,recruiter:'ui_confirmed',accountDisplayName:name});
async function fixture(t,{targets=[tab('one')],saved,probes={}}={}) {
  const dir=await mkdtemp(join(tmpdir(),'boss-registry-')); t.after(()=>rm(dir,{recursive:true,force:true}));
  const config={profile:'company-2',endpoint:'http://127.0.0.1:19335',runtimeDir:dir,profileDir:join(dir,'chrome-profile')};
  await writeFile(join(dir,'launch.json'),JSON.stringify(config));
  if (saved) await writeFile(join(dir,'browser-binding.json'),JSON.stringify({schemaVersion:1,...config,targetId:saved,url:'https://www.zhipin.com/web/chat/index',accountDisplayName:'汪女士'}));
  const calls=[];
  const deps={listTargets:async endpoint=>{assert.equal(endpoint,config.endpoint); return targets;},
    probeTarget:async target=>{calls.push(target.id); if(probes[target.id] instanceof Error)throw probes[target.id]; return probes[target.id] || observed();}};
  return {config,deps,calls,dir};
}

test('finds one recruiter page among unrelated tabs and stores safe durable binding',async t=>{
  const f=await fixture(t,{targets:[tab('home','https://www.zhipin.com/'),tab('personal','https://www.zhipin.com/web/geek/chat'),tab('foreign','https://example.com/private'),tab('one')]});
  const result=await resolveRecruiterTarget({config:f.config,expectedAccountDisplayName:'汪女士'},f.deps);
  assert.equal(result.target.id,'one'); assert.deepEqual(f.calls,['one']);
  const raw=await readFile(result.bindingPath,'utf8'); const binding=JSON.parse(raw);
  assert.equal(binding.targetId,'one');assert.equal(binding.accountDisplayName,'汪女士');
  assert.ok(!raw.includes('private=value'));assert.ok(!raw.includes('webSocketDebuggerUrl'));assert.ok(!raw.includes('runtimeDir'));
});

test('saved target resolves several same-account tabs but is freshly verified',async t=>{
  const f=await fixture(t,{targets:[tab('two'),tab('one')],saved:'one'});
  assert.equal((await resolveRecruiterTarget({config:f.config},f.deps)).target.id,'one');
  assert.deepEqual(f.calls,['one']);
});

test('stale binding rebinds a unique freshly verified target',async t=>{
  const f=await fixture(t,{saved:'gone'});
  const result=await resolveRecruiterTarget({config:f.config},f.deps);
  assert.equal(result.binding.targetId,'one');assert.deepEqual(f.calls,['one']);
});

test('ambiguous same-account tabs require explicit selection and do not persist guess',async t=>{
  const f=await fixture(t,{targets:[tab('one'),tab('two')]});
  await assert.rejects(resolveRecruiterTarget({config:f.config,expectedAccountDisplayName:'汪女士'},f.deps),e=>e.code==='AMBIGUOUS_RECRUITER_TARGET'&&e.targets.length===2&&!JSON.stringify(e.targets).includes('private=value'));
  await assert.rejects(readFile(join(f.dir,'browser-binding.json')),e=>e.code==='ENOENT');
  const explicit=await resolveRecruiterTarget({config:f.config,targetId:'two',expectedAccountDisplayName:'汪女士'},f.deps);
  assert.equal(explicit.binding.targetId,'two');
});

test('explicit wrong target never falls back and wrong account is not adopted',async t=>{
  const f=await fixture(t,{targets:[tab('one'),tab('two')],probes:{one:observed('另一账号')}});
  await assert.rejects(resolveRecruiterTarget({config:f.config,targetId:'missing'},f.deps),{code:'TARGET_NOT_ALLOWED'});
  await assert.rejects(resolveRecruiterTarget({config:f.config,targetId:'one',expectedAccountDisplayName:'汪女士'},f.deps),{code:'ACCOUNT_CHANGED'});
  assert.deepEqual(f.calls,['one']);
});

test('wrong account in saved target fails closed despite matching other tab',async t=>{
  const f=await fixture(t,{targets:[tab('one'),tab('two')],saved:'one',probes:{one:observed('另一账号')}});
  await assert.rejects(resolveRecruiterTarget({config:f.config},f.deps),{code:'ACCOUNT_CHANGED'});
  assert.deepEqual(f.calls,['one']);
});

test('login or unverified recruiter UI does not count as valid target',async t=>{
  const f=await fixture(t,{probes:{one:observed('汪女士','LOGIN_SUSPECTED')}});
  await assert.rejects(resolveRecruiterTarget({config:f.config},f.deps),{code:'NO_VERIFIED_RECRUITER_TARGET'});
});

test('launch mismatch blocks all endpoint and DOM access',async t=>{
  const f=await fixture(t);await writeFile(join(f.dir,'launch.json'),JSON.stringify({...f.config,profile:'company'}));
  await assert.rejects(resolveRecruiterTarget({config:f.config},f.deps),{code:'PROFILE_CONNECTION_UNVERIFIED'});
  assert.deepEqual(f.calls,[]);
});

test('corrupt or conflicting saved account binding fails closed',async t=>{
  const f=await fixture(t,{saved:'one'});
  await assert.rejects(resolveRecruiterTarget({config:f.config,expectedAccountDisplayName:'何女士'},f.deps),{code:'ACCOUNT_BINDING_MISMATCH'});
  await writeFile(join(f.dir,'browser-binding.json'),'broken');
  await assert.rejects(resolveRecruiterTarget({config:f.config},f.deps),{code:'BROWSER_BINDING_INVALID'});
});

test('inventory visits registered profiles only and hides foreign pages and query data',async()=>{
  const calls=[];
  const config={profile:'company-2',endpoint:'http://127.0.0.1:19335',runtimeDir:'registered',profileDir:'registered/profile'};
  const deps={loadConfig:env=>({...config,profile:env.BOSS_PROFILE,runtimeDir:env.BOSS_PROFILE==='company-2'?'registered':'missing'}),
    readFile:async path=>{if(String(path).endsWith('launch.json')&&String(path).startsWith('registered'))return JSON.stringify(config);throw Object.assign(new Error(),{code:'ENOENT'});},
    listTargets:async endpoint=>{calls.push(endpoint);return [tab('one'),tab('foreign','https://other.test/secret?token=token'),tab('home','https://www.zhipin.com/?tracking=token')];},
    probeTarget:async()=>observed()};
  const result=await listKnownBossBrowsers({},deps);
  assert.equal(result.browsers.length,3);assert.deepEqual(calls,[config.endpoint]);
  assert.equal(result.browsers[2].status,'connected');assert.equal(result.browsers[2].pages.length,2);
  assert.ok(!JSON.stringify(result).includes('token'));assert.ok(!JSON.stringify(result).includes('other.test'));
});
