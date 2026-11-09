import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.mjs';

test('all three profiles have separate session directories and default endpoints', () => {
  const personal = loadConfig({}), company = loadConfig({ BOSS_PROFILE: 'company' });
  const second = loadConfig({ BOSS_PROFILE: 'company-2' });
  assert.equal(personal.port, 19333);
  assert.equal(company.port, 19334);
  assert.equal(second.port, 19335);
  assert.equal(second.endpoint, 'http://127.0.0.1:19335');
  assert.notEqual(personal.profileDir, company.profileDir);
  assert.notEqual(personal.runtimeDir, company.runtimeDir);
  assert.ok(company.profileDir.endsWith('company\\chrome-profile') || company.profileDir.endsWith('company/chrome-profile'));
  assert.ok(second.profileDir.endsWith('company-2\\chrome-profile') || second.profileDir.endsWith('company-2/chrome-profile'));
  assert.equal(new Set([personal, company, second].map(c => c.profileDir)).size, 3);
  assert.equal(new Set([personal, company, second].map(c => c.runtimeDir)).size, 3);
});
test('profile names cannot escape the designated storage directory', () => {
  for (const name of ['../personal', '', 'Company', 'C:\\Users\\admin', '../../']) {
    assert.throws(() => loadConfig({ BOSS_PROFILE: name }), { code: 'INVALID_PROFILE' });
  }
});
test('port override never changes the selected profile directory', () => {
  for (const profile of ['personal', 'company', 'company-2']) {
    const a = loadConfig({ BOSS_PROFILE: profile });
    const b = loadConfig({ BOSS_PROFILE: profile, BOSS_CDP_PORT: '19444' });
    assert.equal(a.profileDir, b.profileDir);
    assert.equal(b.port, 19444);
  }
});
test('every reserved default port rejects the other profiles but accepts its owner', () => {
  const defaults = { personal:19333, company:19334, 'company-2':19335 };
  for (const profile of Object.keys(defaults)) {
    for (const [owner, port] of Object.entries(defaults)) {
      const input = { BOSS_PROFILE:profile, BOSS_CDP_PORT:String(port) };
      if (owner === profile) assert.equal(loadConfig(input).port, port);
      else assert.throws(() => loadConfig(input), { code:'PROFILE_PORT_CONFLICT' });
    }
  }
});
