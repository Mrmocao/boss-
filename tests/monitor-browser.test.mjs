import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { MonitorBrowser, monitorExpression, MONITOR_HOOK_KEY } from '../src/monitor-browser.mjs';

const row = {domRowId:'row-1',name:'Test candidate',jobTitle:'数值策划'};
const account = {displayName:'Test recruiter',identityConfidence:'display_only'};

function harness() {
  let now = 100_000, reads = 0, detailReads = 0, probes = 0, connected = 0, closed = 0;
  const probe = {account,selectedRow:row,epoch:'epoch-1',installed:false,listWindow:{atTop:true,scrollTop:0},
    activity:{typing:false,lastHumanAt:0,manualSelection:false,revision:0,humanConversationIds:[],manualConversationIds:[]}};
  const record = {profile:'company-2',endpoint:'http://127.0.0.1:19335',profileDir:'test-profile'};
  const list = {account,selectedRow:row.domRowId,rows:[row],filters:{job:'全部职位'}};
  const target = {id:'target-1',type:'page',url:'https://www.zhipin.com/web/chat/index',webSocketDebuggerUrl:'ws://127.0.0.1:19335/devtools/page/target-1'};
  const state = {probe,record,list,target,blocked:null,evaluateHook:null};
  class Session {
    async connect() { connected++; }
    async send(method,params) {
      if (method === 'Target.getTargetInfo') return {targetInfo:{url:state.target.url}};
      assert.equal(method,'Runtime.evaluate');
      probes++;
      const args = JSON.parse(params.expression.slice(params.expression.lastIndexOf('})(') + 3,-1));
      state.evaluateHook?.(args);
      if (state.blocked) return {result:{value:{blocked:state.blocked}}};
      if (args.action === 'close') return {result:{value:{closed:true}}};
      if (args.action === 'open') return {result:{value:{opened:true}}};
      return {result:{value:structuredClone(probe)}};
    }
    close() { closed++; }
  }
  const browser = new MonitorBrowser({profile:'company-2',expectedAccountDisplayName:account.displayName},{
    loadConfig:() => ({...record,runtimeDir:'test-runtime'}),readFile:async () => JSON.stringify(record),
    listTargets:async () => [target],CdpSession:Session,now:() => now,settle:async () => {},
    resolveRecruiterTarget:async () => ({target,binding:{targetId:target.id}}),
    createListAdapter:() => ({read:async () => {reads++;return structuredClone(list);}}),
    readSelectedConversation:async () => {detailReads++;return {account,selected:row,candidate:{},messages:[]};},
  });
  return {browser,state,advance:ms => {now += ms;},counts:() => ({reads,detailReads,probes,connected,closed})};
}

test('explicit account binding is required',() => {
  assert.throws(() => new MonitorBrowser({profile:'company-2'}),{code:'ACCOUNT_REQUIRED'});
});

test('unchanged polls stay lightweight; revisions and 10 second fallback reconcile',async () => {
  const h = harness();
  const first = await h.browser.connect();
  assert.equal(first.coverage.fullScan,false);
  assert.equal(first.coverage.list,'visible_window_only');
  assert.equal((await h.browser.poll()).changed,false);
  assert.equal(h.counts().detailReads,1);
  h.state.probe.activity.revision++;
  assert.equal((await h.browser.poll()).changed,true);
  h.advance(10_001);
  assert.equal((await h.browser.poll()).changed,true);
  assert.equal(h.counts().detailReads,3);
  await h.browser.close();
  assert.equal(h.counts().closed,1);
});

test('reload observer replacement forces fresh read and reports reset',async () => {
  const h = harness(); await h.browser.connect();
  h.state.probe.epoch = 'epoch-2'; h.state.probe.installed = true;
  const observation = await h.browser.poll();
  assert.equal(observation.activity.observerReset,true);
  assert.equal(h.counts().detailReads,2);
  await h.browser.close();
});

test('mismatched launch record blocks attachment',async () => {
  const h = harness(); h.state.record.profile = 'company';
  await assert.rejects(h.browser.connect(),{code:'LAUNCH_RECORD_MISMATCH'});
  assert.equal(h.counts().connected,0);
});

test('changed account and target path fail closed even with cached state',async () => {
  const h = harness(); await h.browser.connect();
  h.state.blocked = 'ACCOUNT_CHANGED';
  await assert.rejects(h.browser.poll(),{code:'ACCOUNT_CHANGED'});
  h.state.blocked = null; h.state.target.url = 'https://www.zhipin.com/web/geek/chat';
  await assert.rejects(h.browser.poll(),{code:'TARGET_CHANGED'});
  await h.browser.close();
});

test('list selection identity drift discards read',async () => {
  const h = harness(); h.state.list.rows = [{...row,name:'Someone else'}];
  await assert.rejects(h.browser.connect(),{code:'CONVERSATION_MISMATCH'});
  assert.equal(h.counts().detailReads,0);
  assert.equal(h.counts().closed,1);
});

test('open fails on human activity and verifies selected row after click',async () => {
  const h = harness(); await h.browser.connect();
  h.state.blocked = 'HUMAN_ACTIVE';
  await assert.rejects(h.browser.openConversation(row),{code:'HUMAN_ACTIVE'});
  h.state.blocked = null;
  await assert.rejects(h.browser.openConversation({...row,domRowId:'row-2'}),{code:'CONVERSATION_MISMATCH'});
  await h.browser.close();
});

test('continuous sending is disabled without touching browser',async () => {
  const h = harness();
  await assert.rejects(h.browser.sendText({expected:row,text:'hello'}),{code:'MONITOR_SEND_DISABLED'});
  assert.equal(h.counts().probes,0);
});

// Small DOM fixture executes the actual serialized browser code, including click and event guards.
function domFixture({ siblingEditor = false } = {}) {
  let clicks = 0, observerCallback;
  const handlers = {};
  const make = (extra = {}) => ({nodeType:1,innerText:'',getClientRects:() => [1],querySelector:() => null,
    querySelectorAll:() => [],closest:() => null,...extra});
  const name = make({innerText:row.name}), job = make({innerText:row.jobTitle});
  const selected = make({getAttribute:() => row.domRowId,
    querySelector:s => s === '.geek-name' ? name : s === '.source-job' ? job : null,click:() => {clicks++;}});
  const other = make({getAttribute:() => 'row-2',querySelector:selected.querySelector,click:() => {clicks++;}});
  const list = make({clientHeight:600,scrollTop:0,querySelectorAll:() => [selected,other]});
  list.closest = s => s.includes('.user-list') ? list : null;
  const editor = make({value:'',closest:s => s.includes('contenteditable') || s.includes(siblingEditor ? 'conversation-editor' : 'conversation-main') ? editor : null});
  const editorContainer = make({querySelectorAll:() => [editor]});
  const conversation = make({querySelector:s => s === '.base-name' ? name : s === '.position-name' ? job : null,
    querySelectorAll:() => siblingEditor ? [] : [editor]});
  const profile = make({innerText:account.displayName});
  const nav = [['/web/chat/job/list','职位管理'],['/web/chat/geek/manage_v2','牛人管理'],['/web/chat/index','沟通']]
    .map(([href,innerText]) => make({innerText,getAttribute:() => href}));
  const selectors = {'.top-profile-logout .user-name':profile,'.user-list':list,'.geek-item.selected':selected,'.conversation-main':conversation};
  const context = {URL,Date,Math,location:{href:'https://www.zhipin.com/web/chat/index'},window:{},
    getComputedStyle:() => ({visibility:'visible'}),
    MutationObserver:class {constructor(callback) {observerCallback=callback;} observe() {} disconnect() {}},
    document:{body:make(),querySelector:s => selectors[s] || null,querySelectorAll:s => s === 'a' ? nav : s === '.conversation-editor' && siblingEditor ? [editorContainer] : [],
      addEventListener:(kind,fn) => {handlers[kind]=fn;},removeEventListener:kind => {delete handlers[kind];}}};
  vm.createContext(context);
  const run = (action = 'poll', identity = row) => vm.runInContext(monitorExpression({expectedAccount:account.displayName,owner:'owner',action,row:identity}),context);
  return {run,context,profile,editor,handlers,selected,other,list,clicks:() => clicks,mutate:() => observerCallback([{target:list}])};
}

test('DOM hook rejects wrong account, missing selection and unsafe page',() => {
  const f = domFixture(); f.profile.innerText = 'Other account';
  assert.equal(f.run().blocked,'ACCOUNT_CHANGED');
  f.profile.innerText = account.displayName;
  f.selected.getAttribute = () => null;
  assert.equal(f.run().blocked,'CONVERSATION_UNAVAILABLE');
  f.context.location.href = 'https://example.com/web/chat/index';
  assert.equal(f.run().blocked,'PAGE_CHANGED');
  assert.equal(f.context.window[MONITOR_HOOK_KEY],undefined);
});

test('DOM hook only captures trusted input and keeps human handoff sticky',() => {
  const f = domFixture(); const initial = f.run();
  assert.equal(initial.installed,true);
  f.handlers.input({isTrusted:false,target:f.editor});
  assert.equal(f.run().activity.humanConversationIds.length,0);
  f.handlers.input({isTrusted:true,target:f.editor});
  assert.deepEqual(Array.from(f.run().activity.humanConversationIds),[row.domRowId]);
  assert.equal(f.run('open',{...row,domRowId:'row-2'}).blocked,'HUMAN_ACTIVE');
  const state = f.context.window[MONITOR_HOOK_KEY]; state.lastHumanAt = 1; state.lastInputAt = 1;
  assert.equal(f.run('open').blocked,'HUMAN_HANDOFF');
  assert.equal(f.run('resume').resumed,true);
  assert.equal(f.run().activity.humanConversationIds.length,0);
});

test('DOM hook checks exact visible row before click and never edits message input',() => {
  const f = domFixture(); f.run();
  assert.equal(f.run('open',{...row,domRowId:'row-2',name:'Wrong name'}).blocked,'CONVERSATION_MISMATCH');
  assert.equal(f.clicks(),0);
  assert.equal(f.run('open',{...row,domRowId:'row-2'}).opened,true);
  assert.equal(f.clicks(),1);
  f.editor.value = 'Human draft';
  assert.equal(f.run('open',{...row,domRowId:'row-2'}).blocked,'HUMAN_ACTIVE');
  assert.equal(f.editor.value,'Human draft');
});

test('DOM mutation increments revision; reload reinstalls hook; close removes listeners',() => {
  const f = domFixture(); const initial = f.run(); f.mutate();
  assert.equal(f.run().activity.revision,initial.activity.revision + 1);
  delete f.context.window[MONITOR_HOOK_KEY];
  assert.equal(f.run().installed,true);
  assert.equal(f.run('close').closed,true);
  assert.equal(f.context.window[MONITOR_HOOK_KEY],undefined);
  assert.deepEqual(Object.keys(f.handlers),[]);
});

test('draft present before observer install is sticky handoff without copying draft contents',() => {
  const f = domFixture(); f.editor.value = 'Private unfinished human reply';
  const first = f.run();
  assert.equal(first.activity.typing,true);
  assert.equal(first.activity.hasDraft,true);
  assert.equal(first.activity.handoffRequired,true);
  assert.equal(first.activity.handoffReason,'draft_or_typing');
  assert.deepEqual(Array.from(first.activity.humanConversationIds),[row.domRowId]);
  assert.equal(JSON.stringify(first).includes(f.editor.value),false);
  f.editor.value = '';
  assert.equal(f.run().activity.typing,false);
  assert.equal(f.run().activity.handoffRequired,true);
  assert.equal(f.run('open').blocked,'HUMAN_HANDOFF');
  assert.equal(f.run('resume').resumed,true);
});

test('page reload with restored draft reestablishes human handoff',() => {
  const f = domFixture(); f.run();
  delete f.context.window[MONITOR_HOOK_KEY];
  f.editor.value = 'Restored draft';
  assert.deepEqual(Array.from(f.run().activity.humanConversationIds),[row.domRowId]);
  assert.equal(f.run('resume').blocked,'HUMAN_ACTIVE');
});

test('recruiter editor outside conversation-main detects drafts and trusted human input',() => {
  const f = domFixture({siblingEditor:true});
  f.editor.value = 'Draft in sibling conversation-editor';
  const first = f.run();
  assert.equal(first.activity.hasDraft,true);
  assert.equal(first.activity.handoffRequired,true);
  assert.deepEqual(Array.from(first.activity.humanConversationIds),[row.domRowId]);
  f.editor.value = '';
  assert.equal(f.run().activity.hasDraft,false);
  assert.equal(f.run('resume').resumed,true);
  f.handlers.input({isTrusted:true,target:f.editor});
  assert.equal(f.run().activity.typing,true);
  assert.deepEqual(Array.from(f.run().activity.humanConversationIds),[row.domRowId]);
  assert.equal(f.run('open').blocked,'HUMAN_ACTIVE');
});

test('mutation during full detail read discards snapshot instead of returning stale detail',async () => {
  const h = harness(); await h.browser.connect();
  let probes = 0;
  h.state.evaluateHook = ({action}) => {
    if (action === 'poll' && ++probes === 2) h.state.probe.activity.revision++;
  };
  await assert.rejects(h.browser.scanStep(),{code:'OBSERVATION_CHANGED'});
  h.state.evaluateHook = null;
  assert.equal((await h.browser.poll()).changed,true);
  await h.browser.close();
});

test('current top window visibility is explicit and never implies complete coverage',async () => {
  const h = harness();
  assert.equal((await h.browser.connect()).coverage.topWindowObserved,true);
  h.state.probe.listWindow = {atTop:false,scrollTop:700};
  const next = await h.browser.poll();
  assert.equal(next.coverage.topWindowObserved,false);
  assert.equal(next.coverage.fullScan,false);
  await h.browser.close();
  const f = domFixture();
  assert.equal(f.run().listWindow.atTop,true);
  f.list.scrollTop = 700;
  assert.equal(f.run().listWindow.atTop,false);
});

test('cached polling still exposes typing and sticky handoff to the core',async () => {
  const h = harness(); await h.browser.connect();
  h.state.probe.activity.typing = true;
  h.state.probe.activity.handoffRequired = true;
  h.state.probe.activity.humanConversationIds = [row.domRowId];
  const next = await h.browser.poll();
  assert.equal(next.changed,false);
  assert.equal(next.activity.typing,true);
  assert.equal(next.activity.handoffRequired,true);
  assert.deepEqual(next.activity.humanConversationIds,[row.domRowId]);
  await h.browser.close();
});
