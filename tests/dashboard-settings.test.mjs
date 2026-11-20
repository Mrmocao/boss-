import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {readDashboardSettings,saveAssessmentSettings} from '../src/dashboard-settings.mjs';
import {startMonitorWeb} from '../src/monitor-web.mjs';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'dash-settings-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'config.json');await writeFile(path,JSON.stringify({model:{apiKey:'secret-model',enabled:true,name:'test',baseUrl:'https://model.invalid'},assessment:{filePath:'C:/test.xlsx',delivery:'link',url:'https://hr-youkia.youkia.net/old.xlsx'},mailboxes:[{id:'a',address:'a@example.test',password:'secret-mail',enabled:false}]}));return {root,path};}
const verify=async()=>({bytes:100,sha256:'verified'});
const url='https://hr-youkia.youkia.net/new.xlsx?Expires=2000000000&Signature=a%2Bb';
test('assessment edit validates, keeps unrelated credentials, never includes them in response',async t=>{
 const f=await fixture(t),view=await readDashboardSettings(f.path);assert.ok(!JSON.stringify(view).includes('secret-'));
 const saved=await saveAssessmentSettings(f.path,{url,revision:view.revision},{verify});assert.equal(saved.saved,true);assert.equal(saved.assessment.url,url);assert.notEqual(saved.revision,view.revision);
 const raw=JSON.parse(await readFile(f.path,'utf8'));assert.equal(raw.model.apiKey,'secret-model');assert.equal(raw.mailboxes[0].password,'secret-mail');assert.equal(raw.assessment.filePath,'C:/test.xlsx');
 await assert.rejects(saveAssessmentSettings(f.path,{url,revision:view.revision},{verify}),{code:'SETTINGS_CHANGED'});
});
test('invalid URLs, expired links and failed download leave configuration untouched',async t=>{
 const f=await fixture(t),view=await readDashboardSettings(f.path),before=await readFile(f.path,'utf8');
 for(const invalid of ['http://127.0.0.1:19335/a.xlsx','https://hr-youkia.youkia.net/a.xlsx?Expires=1','https://hr-youkia.youkia.net.evil.test/a.xlsx','https://user:pass@hr-youkia.youkia.net/a.xlsx'])await assert.rejects(saveAssessmentSettings(f.path,{url:invalid,revision:view.revision},{verify:()=>assert.fail('network not allowed')}));
 await assert.rejects(saveAssessmentSettings(f.path,{url,revision:view.revision},{verify:async()=>{throw Object.assign(Error(),{code:'ASSESSMENT_LINK_UNREACHABLE'});}}));assert.equal(await readFile(f.path,'utf8'),before);
});
test('preserves mailbox edits during verification and rejects a competing assessment edit',async t=>{
 const f=await fixture(t),view=await readDashboardSettings(f.path);
 await saveAssessmentSettings(f.path,{url,revision:view.revision},{verify:async()=>{const c=JSON.parse(await readFile(f.path));c.mailboxes[0].password='changed';await writeFile(f.path,JSON.stringify(c));return verify();}});
 assert.equal(JSON.parse(await readFile(f.path)).mailboxes[0].password,'changed');
 const next=await readDashboardSettings(f.path);
 await assert.rejects(saveAssessmentSettings(f.path,{url,revision:next.revision},{verify:async()=>{const c=JSON.parse(await readFile(f.path));c.assessment.url='https://hr-youkia.youkia.net/other.xlsx';await writeFile(f.path,JSON.stringify(c));return verify();}}),{code:'SETTINGS_CHANGED'});
});
test('settings HTTP requires origin and token, does not allow extra credential fields',async t=>{
 const f=await fixture(t),server=await startMonitorWeb({port:0,root:f.root,settingsPath:f.path,verifyDownload:verify});t.after(()=>new Promise(r=>server.close(r)));const origin=`http://127.0.0.1:${server.address().port}`;
 const html=await(await fetch(origin)).text(),token=/name="csrf" content="([a-f0-9]+)"/.exec(html)[1];
 assert.equal((await fetch(origin+'/api/settings')).status,403);
 const headers={'X-CSRF-Token':token,Origin:origin,'Content-Type':'application/json'};
 const view=await(await fetch(origin+'/api/settings',{headers})).json();assert.ok(!JSON.stringify(view).includes('secret-'));
 assert.equal((await fetch(origin+'/api/settings',{method:'POST',headers:{...headers,Origin:'https://evil.test'},body:JSON.stringify({url,revision:view.revision})})).status,403);
 assert.equal((await fetch(origin+'/api/settings',{method:'POST',headers,body:JSON.stringify({url,revision:view.revision,model:{apiKey:'replace'}})})).status,400);
 const response=await fetch(origin+'/api/settings',{method:'POST',headers,body:JSON.stringify({url,revision:view.revision})});assert.equal(response.status,200);assert.equal((await response.json()).saved,true);
});
