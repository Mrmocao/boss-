import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPage, probePage } from '../src/page-status.mjs';
import { loadConfig } from '../src/config.mjs';
import { pageProbe } from '../src/page-status.mjs';
import { runInNewContext } from 'node:vm';

test('a public page and matching words alone never prove recruiter login', () => {
  assert.equal(classifyPage({ url: 'https://www.zhipin.com/', text: '沟通 职位管理' }).state, 'PAGE_READABLE_UNVERIFIED');
  assert.equal(classifyPage({ url: 'https://www.zhipin.com/web/boss/chat', text: '沟通 职位管理' }).login, 'likely');
});
test('verification takes precedence over apparent recruiter navigation', () => {
  assert.equal(classifyPage({ url: 'https://www.zhipin.com/web/boss/chat', text: '沟通 职位管理 请完成验证' }).state, 'VERIFICATION_SUSPECTED');
});
test('wrong origin and jobseeker role fail closed', () => {
  assert.equal(classifyPage({ url: 'https://www.zhipin.com.evil.test/web/boss/', text: '沟通 职位管理' }).state, 'UNEXPECTED_ORIGIN');
  assert.equal(classifyPage({ url: 'https://www.zhipin.com/web/geek/chat', text: '沟通' }).state, 'JOBSEEKER_PAGE');
});
test('login text produces an unconfirmed signal, not an authenticated result', () => {
  assert.equal(classifyPage({ url: 'https://www.zhipin.com/web/boss/', text: '扫码登录 沟通 职位管理' }).state, 'LOGIN_SUSPECTED');
});
test('observed personal-account navigation verifies only personal UI login', () => {
  const result = classifyPage({ url: 'https://www.zhipin.com/web/geek/jobs', text: '职位 消息 简历',
    signals: { personalAccountNavigation: true } });
  assert.equal(result.login, 'ui_confirmed');
  assert.equal(result.state, 'JOBSEEKER_PAGE');
  assert.equal(result.recruiter, 'unverified');
  assert.equal(result.conversations, 'unverified');
});
test('real recruiter UI is not invalidated by login wording in candidate messages', () => {
  const result = classifyPage({url:'https://www.zhipin.com/web/chat/index', text:'开发过登录注册模块 请完成验证',
    signals:{recruiterAccountNavigation:true,loadedConversationRows:40}});
  assert.equal(result.state, 'RECRUITER_UI_CONFIRMED');
  assert.equal(result.login, 'ui_confirmed');
  assert.equal(result.conversations, 'list_observed');
  assert.equal(result.loadedConversationRows, 40);
});
test('visible login or verification controls override recruiter navigation', () => {
  for (const [key,state] of [['loginControl','LOGIN_SUSPECTED'],['verificationControl','VERIFICATION_SUSPECTED']]) {
    const result=classifyPage({url:'https://www.zhipin.com/web/chat/index', text:'',
      signals:{recruiterAccountNavigation:true,[key]:true}});
    assert.equal(result.state,state);
    assert.notEqual(result.login,'ui_confirmed');
  }
});
test('recruiter route alone and empty conversation list do not prove message access', () => {
  assert.equal(classifyPage({url:'https://www.zhipin.com/web/chat/index',text:'职位管理 沟通'}).login,'unknown');
  const result=classifyPage({url:'https://www.zhipin.com/web/chat/index',text:'',signals:{recruiterAccountNavigation:true,loadedConversationRows:0}});
  assert.equal(result.conversations,'unverified');
});
test('in-page guard blocks foreign origins before touching the document', () => {
  for (const href of ['https://example.org/', 'https://www.zhipin.com.evil.test/', 'https://user@www.zhipin.com/']) {
    let touched = false;
    const sandbox = { location: { href }, URL, get document() { touched = true; throw Error('Unexpected DOM read'); } };
    assert.equal(runInNewContext(pageProbe, sandbox).blocked, true);
    assert.equal(touched, false);
  }
});
test('malformed ports are rejected before launch', () => {
  for (const value of ['0', '80', '65536', '19333.0', '19333 --x', 'NaN']) {
    assert.throws(() => loadConfig({ BOSS_CDP_PORT: value }), { code: 'INVALID_PORT' });
  }
});

test('observed navigation tracking query is accepted but foreign and wrong-path links are not', () => {
  const href = 'https://www.zhipin.com/web/chat/index';
  function probe(chatHref) {
    const element = (text, link) => ({ innerText:text, getClientRects:()=>[{}], getAttribute:()=>link });
    const links = [element('职位管理','/web/chat/job/list'),element('牛人管理','/web/chat/geek/manage_v2'),element('沟通\n212',chatHref)];
    return runInNewContext(pageProbe, { URL, location:{href}, getComputedStyle:()=>({visibility:'visible'}),
      document:{readyState:'complete',body:{innerText:''},
        querySelector:s=>s==='.top-profile-logout .user-name'?element('测试账号'):null,
        querySelectorAll:s=>s==='a'?links:[]}}).signals.recruiterAccountNavigation;
  }
  assert.equal(probe('/web/chat/index?ka=menu-im'), true);
  assert.equal(probe('https://www.zhipin.com/web/chat/index?ka=menu-im'), true);
  for (const bad of ['https://example.org/web/chat/index?ka=menu-im', '/web/chat/index/other',
    'https://user@www.zhipin.com/web/chat/index', 'javascript:alert(1)']) assert.equal(probe(bad), false);
});
test('navigation away between target selection and read prevents evaluation', async () => {
  let evaluated = false;
  const session = { send: async method => {
    if (method === 'Runtime.evaluate') evaluated = true;
    return { targetInfo: { url: 'https://example.org/' } };
  } };
  await assert.rejects(probePage(session, { id: 'a' }), { code: 'TARGET_CHANGED' });
  assert.equal(evaluated, false);
});
test('navigation during read discards page data', async () => {
  let checks = 0;
  const session = { send: async method => {
    if (method === 'Runtime.evaluate') return { result: { value: { url: 'https://www.zhipin.com/web/boss/chat', text: 'private conversation' } } };
    return { targetInfo: { url: ++checks === 1 ? 'https://www.zhipin.com/web/boss/chat' : 'https://example.org/' } };
  } };
  await assert.rejects(probePage(session, { id: 'a' }), { code: 'TARGET_CHANGED' });
});
test('status returns signals without exposing page text or query parameters', async () => {
  const url = 'https://www.zhipin.com/web/boss/chat?private=value';
  const session = { send: async method => method === 'Runtime.evaluate'
    ? { result: { value: { url, text: '沟通 职位管理 PRIVATE_PERSON', ready: 'complete', frames: 1 } } }
    : { targetInfo: { url } } };
  const output = JSON.stringify(await probePage(session, { id: 'a' }));
  assert.ok(!output.includes('PRIVATE_PERSON'));
  assert.ok(!output.includes('private=value'));
  assert.ok(output.includes('unverified'));
});
