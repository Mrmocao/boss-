import test from 'node:test';
import assert from 'node:assert/strict';
import { readSelectedConversation } from '../src/recruiter-detail.mjs';

function sessionWith(value, finalUrl='https://www.zhipin.com/web/chat/index') {
  return { send: async method => method === 'Runtime.evaluate' ? {result:{value}} : {targetInfo:{url:finalUrl}} };
}
const base = { blocked:null, account:{displayName:'招聘员',identityConfidence:'display_only'}, selected:{domRowId:'row-1',name:'候选人',jobTitle:'数值策划'}, candidate:{name:'候选人'}, messages:[], sideEffects:['may_mark_read'], sourceUrl:'https://www.zhipin.com/web/chat/index' };

test('detail reader requires the same selected candidate and account', async () => {
  const data = await readSelectedConversation(sessionWith(base), {targetId:'t',domRowId:'row-1',name:'候选人',jobTitle:'数值策划',accountDisplayName:'招聘员'});
  assert.equal(data.sideEffects[0], 'may_mark_read');
  await assert.rejects(readSelectedConversation(sessionWith({...base,selected:{...base.selected,name:'另一个人'}}), {targetId:'t',domRowId:'row-1',name:'候选人',jobTitle:'数值策划',accountDisplayName:'招聘员'}), {code:'CONVERSATION_MISMATCH'});
  await assert.rejects(readSelectedConversation(sessionWith(base), {targetId:'t',domRowId:'row-1',name:'候选人',jobTitle:'数值策划',accountDisplayName:'另一账号'}), {code:'ACCOUNT_CHANGED'});
});

test('detail reader rejects blocked pages and navigation races', async () => {
  await assert.rejects(readSelectedConversation(sessionWith({blocked:'ACCOUNT_UNVERIFIED'}), {targetId:'t',domRowId:'row-1',name:'候选人',jobTitle:'数值策划',accountDisplayName:'招聘员'}), {code:'ACCOUNT_UNVERIFIED'});
  await assert.rejects(readSelectedConversation(sessionWith(base,'https://example.org/'), {targetId:'t',domRowId:'row-1',name:'候选人',jobTitle:'数值策划',accountDisplayName:'招聘员'}), {code:'TARGET_CHANGED'});
});

test('same URL account or candidate changes after the first read discard the result', async () => {
  for (const changed of [{...base,account:{displayName:'其他账号'}},{...base,selected:{...base.selected,domRowId:'row-2'}}]) {
    let reads=0;
    const s={send:async method=>method==='Runtime.evaluate'?{result:{value:++reads===1?base:changed}}:{targetInfo:{url:base.sourceUrl}}};
    await assert.rejects(readSelectedConversation(s,{targetId:'t',domRowId:'row-1',name:'候选人',jobTitle:'数值策划',accountDisplayName:'招聘员'}),{code:'CONVERSATION_MISMATCH'});
  }
});

test('messages that change while reading are not stored as a stable observation', async () => {
  let reads=0;
  const s={send:async method=>method==='Runtime.evaluate'?{result:{value:++reads===1?base:{...base,messages:[{text:'new'}]}}}:{targetInfo:{url:base.sourceUrl}}};
  await assert.rejects(readSelectedConversation(s,{targetId:'t',domRowId:'row-1',name:'候选人',jobTitle:'数值策划',accountDisplayName:'招聘员'}),{code:'DETAIL_CHANGED'});
});
