import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startMonitorWeb} from '../src/monitor-web.mjs';
test('local dashboard blocks foreign origin, write CSRF, arbitrary commands and raw state file',async t=>{
 const root=await mkdtemp(join(tmpdir(),'dashboard-http-'));const server=await startMonitorWeb({port:0,root});
 t.after(async()=>{await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});const origin=`http://127.0.0.1:${server.address().port}`;
 const page=await (await fetch(origin)).text();const token=/name="csrf" content="([a-f0-9]+)"/.exec(page)[1];
 assert.equal((await fetch(origin+'/health')).status,200);assert.equal((await fetch(origin+'/api/state',{headers:{Origin:'https://evil.example'}})).status,403);
 assert.equal((await fetch(origin+'/api/command',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
 assert.equal((await fetch(origin+'/api/command',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,'X-CSRF-Token':token},body:JSON.stringify({command:'arbitrary-send'})})).status,400);
 assert.equal((await fetch(origin+'/state.json')).status,404);
 const malicious='<img src=x onerror=alert(1)>';
 await writeFile(join(root,'state.json'),JSON.stringify({conversations:{x:{id:'x',admitted:true,name:malicious}},notifications:[],sentIntents:{},runtime:{},controls:{}}));
 const payload=await(await fetch(origin+'/api/state')).json();assert.equal(payload.conversations[0].name,malicious);
 const script=await(await fetch(origin+'/dashboard.js')).text();assert.ok(!script.includes('.innerHTML'));assert.ok(script.includes('.textContent'));
});
test('workflow settings route is CSRF protected and does not expose secrets',async t=>{
 const root=await mkdtemp(join(tmpdir(),'workflow-http-'));const configPath=join(root,'config.json');await writeFile(configPath,JSON.stringify({model:{apiKey:'secret-model'},mailboxes:[{password:'secret-mail'}],workflow:{prompt:'old',requirements:'old',stageNotes:{}}}));const server=await startMonitorWeb({port:0,root,settingsPath:configPath});t.after(async()=>{await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});const origin=`http://127.0.0.1:${server.address().port}`;const page=await(await fetch(origin)).text();const token=/name="csrf" content="([a-f0-9]+)"/.exec(page)[1];assert.equal((await fetch(origin+'/api/workflow')).status,403);const headers={'X-CSRF-Token':token,Origin:origin,'Content-Type':'application/json'};const current=await(await fetch(origin+'/api/workflow',{headers})).json();assert.ok(!JSON.stringify(current).includes('secret-'));const saved=await(await fetch(origin+'/api/workflow',{method:'POST',headers,body:JSON.stringify({revision:current.revision,prompt:'new',requirements:'requirements',stageNotes:{}})})).json();assert.equal(saved.saved,true);assert.equal((await fetch(origin+'/api/workflow',{headers})).status,200);});
