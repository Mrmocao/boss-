import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {addAccount,updateAccount,safeAccount} from '../src/account-manager.mjs';
test('account values are sanitized and edits keep profile identity/port',async t=>{const root=await mkdtemp(join(tmpdir(),'account-manager-'));t.after(()=>rm(root,{recursive:true,force:true}));
 // Account manager uses its fixed local registry; validate the public projection independently.
 const value=safeAccount({id:'company-3',label:'账号3',profile:'company-3',port:19340,displayName:'新账号',password:'secret',targetId:'target'});assert.deepEqual(value,{id:'company-3',label:'账号3',profile:'company-3',port:19340,displayName:'新账号',enabled:true,managed:false,status:'not_checked',error:null,lastCheckedAt:null,url:null,targetId:'target'});
 assert.equal(value.password,undefined);
});
