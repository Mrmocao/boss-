import { fileURLToPath } from 'node:url';
import { resolve, join, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const loginUrl = 'https://www.zhipin.com/web/user/?intent=1';
export const profilePorts = Object.freeze({ personal: 19333, company: 19334, 'company-2': 19335 });

export function loadConfig(env = process.env) {
  const profile = env.BOSS_PROFILE ?? 'personal';
  if (!Object.hasOwn(profilePorts, profile)) {
    throw Object.assign(new Error('BOSS_PROFILE must be personal, company or company-2.'), { code: 'INVALID_PROFILE' });
  }
  const raw = env.BOSS_CDP_PORT ?? String(profilePorts[profile]);
  if (!/^\d+$/.test(raw) || Number(raw) < 1024 || Number(raw) > 65535) {
    throw Object.assign(new Error('BOSS_CDP_PORT must be an integer from 1024 to 65535.'), { code: 'INVALID_PORT' });
  }
  if (Object.entries(profilePorts).some(([owner, port]) => owner !== profile && port === Number(raw))) {
    throw Object.assign(new Error('The selected port is reserved for the other profile. Remove BOSS_CDP_PORT or choose a separate port.'), { code: 'PROFILE_PORT_CONFLICT' });
  }
  const choices = [env.BOSS_CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  const chromePath = env.BOSS_CHROME_PATH || choices.find(p => existsSync(p));
  if (chromePath && !isAbsolute(chromePath)) {
    throw Object.assign(new Error('BOSS_CHROME_PATH must be absolute.'), { code: 'INVALID_CHROME_PATH' });
  }
  const runtimeDir = profile === 'personal' ? join(projectRoot, '.runtime') : join(projectRoot, '.runtime', profile);
  return {
    profile,
    port: Number(raw), endpoint: `http://127.0.0.1:${Number(raw)}`,
    chromePath, profileDir: resolve(runtimeDir, 'chrome-profile'), runtimeDir,
  };
}
