import { spawnSync } from 'node:child_process';
const env = { ...process.env, VITE_BUILD_CHANNEL:'LOCAL', VITE_BUILD_VERSION:'1.8.5-live-home.1' };
for (const [command,args] of [['npm',['run','build']],['./node_modules/.bin/electron-builder',['--dir','--mac','--arm64','--publish','never','--config','electron-builder.live-home.cjs']]]) {
  const result = spawnSync(command,args,{env,stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
