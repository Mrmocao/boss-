import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {followupExpression,followupFingerprint} from '../src/authorized-followup.mjs';

const expected={domRowId:'candidate-1',name:'候选人',jobTitle:'数值策划'};
const messages=[{direction:'incoming',kind:'text',text:'愿意聊聊'}];
const plain={action:'send',text:'请介绍一下游戏经历',expected,messages,account:'汪女士',owner:'owner-1'};
function fixture(overrides={}) {
  const value={clicked:0,focused:0,events:0};
  const element=text=>({innerText:text,getClientRects:()=>[{}],querySelector:()=>null,getAttribute:()=>null});
  const editor={...element(overrides.draft??plain.text),focus:()=>value.focused++,dispatchEvent:()=>value.events++};
  Object.defineProperty(editor,'textContent',{set:text=>editor.innerText=text});
  const button={...element('发送'),click:()=>value.clicked++,classList:{contains:()=>false}};
  const row={...element(''),getAttribute:()=>overrides.domRowId??expected.domRowId,querySelector:s=>element(s==='.geek-name'?(overrides.name??expected.name):expected.jobTitle)};
  const root={...element(''),querySelector:s=>element(s==='.base-name'?expected.name:expected.jobTitle)};
  const direction=overrides.direction??'incoming';
  const message={...element(''),querySelector:s=>s==='.item-friend'&&direction==='incoming'?{}:
    s==='.item-myself'&&direction==='outgoing'?{}:
    s==='.text-content'?element(overrides.message??messages[0].text):
    s==='.status.status-delivery,.status.status-read'&&overrides.status?element(overrides.status):null};
  const hook={owner:overrides.owner??plain.owner,lastHumanAt:overrides.lastHumanAt??0,humanConversationIds:overrides.humanIds??[],manualConversationIds:overrides.manualIds??[]};
  const selectors={'.top-profile-logout .user-name':element(overrides.account??plain.account),'.geek-item.selected':row,'.conversation-main':root};
  const lists={'.conversation-editor #boss-chat-editor-input[contenteditable="true"]':[editor],'.conversation-editor .submit':[button],'.conversation-main .chat-message-list .message-item':[message]};
  return {value,editor,button,sandbox:{location:{origin:overrides.origin??'https://www.zhipin.com',pathname:'/web/chat/index'},
    window:{__bossRecruitingMonitorV1:hook},document:{querySelector:s=>selectors[s],querySelectorAll:s=>lists[s]||[]},
    InputEvent:class{},Date,JSON}};
}
const run=(f,args={})=>runInNewContext(followupExpression({...plain,...args}),f.sandbox);

test('single send guard clicks only exact verified account conversation text and draft',()=>{
  const f=fixture(); assert.equal(run(f).clicked,true);assert.equal(f.value.clicked,1);
});

test('identity, account, observer ownership and page changes prevent click',()=>{
  for(const overrides of [{account:'其他账号'},{domRowId:'other'},{name:'其他人'},{owner:'other'},{origin:'https://evil.test'}]) {
    const f=fixture(overrides);assert.ok(run(f).blocked);assert.equal(f.value.clicked,0);
  }
});

test('new messages and modified draft block sending without modifying the editor',()=>{
  for(const overrides of [{message:'候选人又回复了'},{draft:'人工尚未发送的内容'}]) {
    const f=fixture(overrides);const before=f.editor.innerText;
    assert.ok(run(f).blocked);assert.equal(f.value.clicked,0);assert.equal(f.editor.innerText,before);
  }
});

test('recent trusted human activity and sticky conversation handoff block sending',()=>{
  for(const overrides of [{lastHumanAt:Date.now()},{humanIds:[expected.domRowId]},{manualIds:[expected.domRowId]}]) {
    const f=fixture(overrides);assert.equal(run(f).blocked,'HUMAN_ACTIVE');assert.equal(f.value.clicked,0);
  }
});

test('fill refuses existing draft and performs input only after empty editor verification',()=>{
  const occupied=fixture({draft:'人工草稿'});assert.equal(run(occupied,{action:'fill'}).blocked,'DRAFT_PRESENT');assert.equal(occupied.value.events,0);
  const empty=fixture({draft:''});assert.equal(run(empty,{action:'fill'}).filled,true);
  assert.equal(empty.editor.innerText,plain.text);assert.equal(empty.value.events,1);assert.equal(empty.value.clicked,0);
});

test('disabled send control prevents click',()=>{
  const f=fixture();f.button.classList.contains=()=>true;
  assert.equal(run(f).blocked,'DRAFT_CHANGED');assert.equal(f.value.clicked,0);
});

test('message fingerprint ignores delivery text but detects changed conversation content',()=>{
  const initial={messages:[...messages,{direction:'outgoing',kind:'text',text:'你好',displayText:'送达\n你好'}]};
  const read=structuredClone(initial);read.messages[1].displayText='已读\n你好';
  assert.equal(followupFingerprint(initial),followupFingerprint(read));
  read.messages.push({direction:'incoming',kind:'text',text:'新回复'});
  assert.notEqual(followupFingerprint(initial),followupFingerprint(read));
});

test('delivery words in message body are not a receipt without a delivery status element',()=>{
  const text='这条正文里包含送达和已读';
  const f=fixture({draft:'',direction:'outgoing',message:text});
  const result=run(f,{action:'receipt',text,messages:[{direction:'outgoing',kind:'text',text}]});
  assert.equal(result.confirmed,false);assert.equal(result.status,null);assert.equal(f.value.clicked,0);
});

test('receipt requires exact outgoing text, delivery status and empty editor',()=>{
  for(const status of ['送达','已读']) {
    const f=fixture({draft:'',direction:'outgoing',message:plain.text,status});
    const result=run(f,{action:'receipt',messages:[{direction:'outgoing',kind:'text',text:plain.text}]});
    assert.equal(result.confirmed,true);assert.equal(result.status,status);assert.equal(f.value.clicked,0);
  }
  for(const overrides of [{draft:plain.text,status:'送达'}, {draft:'',status:'发送中'}, {draft:'',status:'未送达'}]) {
    const f=fixture({...overrides,direction:'outgoing',message:plain.text});
    assert.equal(run(f,{action:'receipt',messages:[{direction:'outgoing',kind:'text',text:plain.text}]}).confirmed,false);
  }
  const incoming=fixture({draft:'',message:plain.text,status:'送达'});
  assert.equal(run(incoming,{action:'receipt',messages:[{direction:'incoming',kind:'text',text:plain.text}]}).confirmed,false);
  const mismatch=fixture({draft:'',direction:'outgoing',message:'另一个消息',status:'送达'});
  assert.equal(run(mismatch,{action:'receipt',messages:[{direction:'outgoing',kind:'text',text:'另一个消息'}]}).confirmed,false);
});
