import { writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig, projectRoot } from './config.mjs';
import { listKnownBossBrowsers, resolveRecruiterTarget } from './browser-registry.mjs';

try {
  const [command='list',...args] = process.argv.slice(2);
  if (command === 'list' && !args.length) {
    const result = await listKnownBossBrowsers();
    const root = join(projectRoot,'.local'); await mkdir(root,{recursive:true});
    const path = join(root,'browser-registry.json'); const tmp = `${path}.${randomUUID()}.tmp`;
    await writeFile(tmp,JSON.stringify(result,null,2),'utf8'); await rename(tmp,path);
    console.log(JSON.stringify({...result,registryPath:path},null,2));
  } else if (command === 'bind') {
    const options={};
    for(let i=0;i<args.length;i+=2) {
      if (!['--profile','--account','--target'].includes(args[i]) || !args[i+1] || options[args[i]]) throw new Error('Invalid options');
      options[args[i]]=args[i+1];
    }
    if (!options['--profile']) throw new Error('An explicit --profile is required');
    const config=loadConfig({...process.env,BOSS_PROFILE:options['--profile']});
    const {binding,bindingPath}=await resolveRecruiterTarget({config,
      expectedAccountDisplayName:options['--account'],targetId:options['--target']});
    console.log(JSON.stringify({binding,bindingPath,sendsMessages:false},null,2));
  } else throw new Error('Usage: list | bind --profile company-2 [--account NAME] [--target ID]');
} catch(e) {console.error(JSON.stringify({code:e.code || 'INVALID_COMMAND',message:e.message,targets:e.targets}));process.exitCode=1;}
