import { isBossUrl } from './cdp.mjs';

// Return only classified signals to the caller. Never include page text in diagnostics.
export function classifyPage(page) {
  const unknown = { login: 'unknown', recruiter: 'unverified', conversations: 'unverified' };
  if (!isBossUrl(page.url)) return { state: 'UNEXPECTED_ORIGIN', ...unknown };
  const text = String(page.text || '').replace(/\s+/g, ' ');
  const path = new URL(page.url).pathname;
  if (page.signals?.verificationControl) {
    return { state: 'VERIFICATION_SUSPECTED', ...unknown };
  }
  if (page.signals?.loginControl) {
    return { state: 'LOGIN_SUSPECTED', login: 'not_confirmed', recruiter: 'unverified', conversations: 'unverified' };
  }
  if (path.startsWith('/web/chat/') && page.signals?.recruiterAccountNavigation) {
    return { state: 'RECRUITER_UI_CONFIRMED', login: 'ui_confirmed', recruiter: 'ui_confirmed',
      conversations: Number.isInteger(page.signals.loadedConversationRows) && page.signals.loadedConversationRows > 0 ? 'list_observed' : 'unverified',
      loadedConversationRows: page.signals.loadedConversationRows ?? 0,
      accountIdentity: 'display_only_no_stable_id' };
  }
  if (/安全验证|访问异常|拖动滑块|请完成验证|请完成下方验证|操作过于频繁/.test(text)) {
    return { state: 'VERIFICATION_SUSPECTED', ...unknown };
  }
  if (/扫码登录|短信登录|验证码登录|密码登录|登录注册|登录\/注册/.test(text)) {
    return { state: 'LOGIN_SUSPECTED', login: 'not_confirmed', recruiter: 'unverified', conversations: 'unverified' };
  }
  const recruitmentNavigation = /沟通/.test(text) && /职位管理|招聘职位/.test(text);
  if (path.startsWith('/web/boss/') && recruitmentNavigation) {
    // This is a heuristic until the actual account and conversation are checked.
    return { state: 'RECRUITER_PAGE_DETECTED', login: 'likely', recruiter: 'detected_unverified', conversations: 'unverified' };
  }
  if (/^\/web\/geek\//.test(path)) {
    return { state: 'JOBSEEKER_PAGE', ...unknown,
      login: page.signals?.personalAccountNavigation ? 'ui_confirmed' : 'unknown' };
  }
  return { state: 'PAGE_READABLE_UNVERIFIED', ...unknown };
}

export const pageProbe = `(() => {
  const currentUrl = new URL(location.href);
  if (currentUrl.origin !== 'https://www.zhipin.com' || currentUrl.username || currentUrl.password) return { blocked: true };
  const visible = (e) => e && e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  // Observed in the real personal-account header on 2026-10-30. No name is returned.
  const account = document.querySelector('li.nav-figure');
  const personalAccountNavigation = !!(visible(account) && account.querySelector('img')
    && account.innerText.trim() && Array.from(document.querySelectorAll('a')).some(e =>
      visible(e) && e.innerText.trim() === '消息' && e.href === 'https://www.zhipin.com/web/geek/chat'));
  // Observed recruiter layout on 2026-11-02. Classify from controls, not candidate messages.
  const profile = document.querySelector('.top-profile-logout .user-name');
  const hasNav = (path, label) => Array.from(document.querySelectorAll('a')).some(e => {
    if (!visible(e) || !e.innerText.trim().startsWith(label)) return false;
    try {
      const target = new URL(e.getAttribute('href'), currentUrl);
      return target.origin === currentUrl.origin && !target.username && !target.password && target.pathname === path;
    } catch { return false; }
  });
  const recruiterAccountNavigation = !!(visible(profile) && profile.innerText.trim()
    && hasNav('/web/chat/job/list', '职位管理') && hasNav('/web/chat/geek/manage_v2', '牛人管理')
    && hasNav('/web/chat/index', '沟通'));
  const controls = Array.from(document.querySelectorAll('a,button,[role="button"]')).filter(visible);
  const loginControl = controls.some(e => /^(扫码登录|短信登录|验证码登录|密码登录|登录注册|登录\\/注册)$/.test(e.innerText.trim()));
  const verificationControl = Array.from(document.querySelectorAll('[role="dialog"],.dialog,.modal')).filter(visible)
    .some(e => /安全验证|拖动滑块|请完成验证|请完成下方验证/.test(e.innerText));
  const loadedConversationRows = document.querySelectorAll('.geek-item-top .geek-name').length;
  return {
    url: location.href,
    ready: document.readyState,
    text: (document.body?.innerText || '').slice(0, 60000),
    frames: Array.from(document.querySelectorAll('iframe')).filter(visible).length,
    signals: { personalAccountNavigation, recruiterAccountNavigation, loginControl, verificationControl, loadedConversationRows }
  };
})()`;

export async function probePage(session, target) {
  // Revalidate the live target before each fixed read, not just the originally selected ID.
  const before = await session.send('Target.getTargetInfo', { targetId: target.id });
  if (!isBossUrl(before.targetInfo?.url)) throw Object.assign(new Error('The target left the allowed BOSS origin.'), { code: 'TARGET_CHANGED' });
  const result = await session.send('Runtime.evaluate', { expression: pageProbe, returnByValue: true, timeout: 4000 });
  if (result.exceptionDetails || !result.result?.value) {
    throw Object.assign(new Error('Could not read the BOSS page.'), { code: 'PAGE_READ_FAILED' });
  }
  const page = result.result.value;
  if (page.blocked) throw Object.assign(new Error('The page origin changed before inspection.'), { code: 'TARGET_CHANGED' });
  const after = await session.send('Target.getTargetInfo', { targetId: target.id });
  if (!isBossUrl(page.url) || !isBossUrl(after.targetInfo?.url) || after.targetInfo.url !== page.url) {
    throw Object.assign(new Error('Page changed during the read. Discard this observation and retry after navigation completes.'), { code: 'TARGET_CHANGED' });
  }
  return { ...classifyPage(page), url: new URL(page.url).origin + new URL(page.url).pathname,
    ready: page.ready, visibleFrames: page.frames,
    scope: 'top-level visible text; iframe contents not inspected', sendsMessages: false };
}
