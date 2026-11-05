// 同时启动全部教学站。Ctrl+C 一起退出。
import { spawn } from 'node:child_process';

const SITES = [
  ['protocol-explorer', 5300],
  ['os-explorer', 5301],
  ['algo-explorer', 5302],
  ['codegen-explorer', 5303],
  ['cpu-explorer', 5304],
  ['db-explorer', 5305],
];

const children = SITES.map(([name]) => spawn('npm', ['run', 'dev', '-w', name, '--silent'], { stdio: 'ignore' }));
for (const [name, port] of SITES) console.log(`${name.padEnd(20)} http://localhost:${port}/`);
const stop = () => {
  for (const child of children) child.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const [index, child] of children.entries()) {
  child.on('exit', (code) => {
    if (code) console.error(`${SITES[index][0]} 退出，状态 ${code}`);
  });
}
