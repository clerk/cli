import { statSync } from 'node:fs';
const root = process.argv[2]!;
const binary = `${root}/packages/cli-core/dist/clerk`;
const cases = [[binary, '--version'], [binary, 'apps', 'list', '--help'], ['bun', `${root}/packages/cli-core/src/cli.ts`, 'apps', 'list', '--help']];
const results = [];
const env = { ...process.env, CLERK_TELEMETRY_DISABLED: '1', CLERK_NO_UPDATE_CHECK: '1' };
for (const args of cases) {
  for (let i=0;i<3;i++) Bun.spawnSync(args,{cwd:root,env,stdout:'pipe',stderr:'pipe'});
  const samples=[];
  for(let i=0;i<20;i++) { const start=performance.now(); const result=Bun.spawnSync(args,{cwd:root,env,stdout:'pipe',stderr:'pipe'}); if(result.exitCode!==0) throw Error(result.stderr.toString()); samples.push(performance.now()-start); }
  samples.sort((a,b)=>a-b);
  results.push({args,n:20,medianMs:(samples[9]!+samples[10]!)/2,minMs:samples[0],maxMs:samples[19]});
}
const report={commit:Bun.spawnSync(['git','rev-parse','HEAD'],{cwd:root}).stdout.toString().trim(),bun:Bun.version,platform:process.platform,arch:process.arch,bytes:statSync(binary).size,warmups:3,env:{CLERK_TELEMETRY_DISABLED:'1',CLERK_NO_UPDATE_CHECK:'1'},results};
console.log(JSON.stringify(report,null,2));
