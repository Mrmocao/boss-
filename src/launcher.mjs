import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loginUrl } from './config.mjs';

export async function portAvailable(port) {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export async function launchBrowser(config) {
  if (!config.chromePath || !existsSync(config.chromePath)) {
    throw Object.assign(new Error('Chrome not found. Set BOSS_CHROME_PATH to its absolute executable path.'), { code: 'CHROME_NOT_FOUND' });
  }
  if (!await portAvailable(config.port)) {
    throw Object.assign(new Error('The selected port is occupied. Run status for an existing BOSS session; do not attach to an unknown service.'), { code: 'PORT_IN_USE' });
  }
  let previous;
  try { previous = JSON.parse(await readFile(join(config.runtimeDir, 'launch.json'), 'utf8')); } catch { /* First run or invalid diagnostic record. */ }
  if (previous?.profileDir === config.profileDir && previous.endpoint !== config.endpoint
      && /^http:\/\/127\.0\.0\.1:\d+$/.test(previous.endpoint)) {
    try {
      const response = await fetch(`${previous.endpoint}/json/version`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
      if (response.ok) throw Object.assign(new Error('The dedicated profile is already running on its previous port. Use that port or close its Chrome window first.'), { code: 'PROFILE_IN_USE' });
    } catch (error) { if (error.code === 'PROFILE_IN_USE') throw error; }
  }
  await mkdir(config.profileDir, { recursive: true });
  const child = spawn(config.chromePath, [
    `--remote-debugging-port=${config.port}`, '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${config.profileDir}`, '--no-first-run', '--no-default-browser-check',
    '--new-window', loginUrl,
  ], { detached: true, stdio: 'ignore' });
  let exited = false;
  child.once('exit', () => { exited = true; });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  child.unref();
  for (let i = 0; i < 30; i++) {
    let info;
    try {
      const r = await fetch(`${config.endpoint}/json/version`, { signal: AbortSignal.timeout(1000), redirect: 'error' });
      const parsed = await r.json();
      if (r.ok && typeof parsed.Browser === 'string') info = parsed;
    } catch { /* Bounded wait for Chrome startup only. */ }
    if (info) {
      try {
        await writeFile(join(config.runtimeDir, 'launch.json'), JSON.stringify({
          profile: config.profile, pid: child.pid, endpoint: config.endpoint, profileDir: config.profileDir, launchedAt: new Date().toISOString(),
        }, null, 2), { flag: 'w' });
      } catch (error) {
        throw Object.assign(new Error('Chrome is running, but its launch record could not be saved. Check storage access before retrying.'), { code: 'SESSION_STORAGE_FAILED', cause: error });
      }
      return { state: 'BROWSER_STARTED', browser: info.Browser, endpoint: config.endpoint,
          login: 'USER_ACTION_REQUIRED', message: '请在专用 Chrome 窗口正常登录招聘账号，完成后运行 status。',
          sendsMessages: false };
    }
    if (exited) throw Object.assign(new Error('Chrome exited before the selected port became ready. Its profile may already be open in another instance.'), { code: 'CHROME_EXITED' });
    await delay(300);
  }
  throw Object.assign(new Error('Chrome was launched but the local connection was not ready. Inspect the browser window before retrying.'), { code: 'STARTUP_TIMEOUT' });
}
