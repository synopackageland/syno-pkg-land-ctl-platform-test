import {win32} from 'node:path';
export function windowsPowerShellEnvironment(source=process.env){
 const get=name=>Object.entries(source).find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1];
 const root=get('SystemRoot')??get('WINDIR')??'C:\\Windows';
 if(!win32.isAbsolute(root)||root.includes('\0'))throw new Error('Invalid Windows system root');
 const home=win32.join(root,'System32','WindowsPowerShell','v1.0'),env={};
 for(const [key,value] of Object.entries(source))if(!['psmodulepath','pshome','psmoduleanalysiscachepath'].includes(key.toLowerCase()))env[key]=value;
 env.PSModulePath=win32.join(home,'Modules');return {file:win32.join(home,'powershell.exe'),env};
}
