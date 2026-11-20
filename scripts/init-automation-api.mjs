import {randomBytes} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {apiConfigPath,readAutomationConfig} from '../src/automation-api.mjs';
await mkdir(dirname(apiConfigPath),{recursive:true});
try{await writeFile(apiConfigPath,JSON.stringify({enabled:true,host:'127.0.0.1',port:19338,token:randomBytes(32).toString('base64url')},null,2)+'\n',{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;}
const c=await readAutomationConfig();console.log(JSON.stringify({configFile:apiConfigPath,enabled:c.enabled,endpoint:`http://${c.host}:${c.port}/api/v1/snapshot`,tokenConfigured:true}));
