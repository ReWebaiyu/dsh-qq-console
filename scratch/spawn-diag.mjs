import { spawn } from 'node:child_process';
import { openSync, readFileSync, rmSync } from 'node:fs';

const out = 'D:/WenJian/DP0.0.1/scratch/spawn-out.log';
const err = 'D:/WenJian/DP0.0.1/scratch/spawn-err.log';
for (const p of [out, err]) { try { rmSync(p); } catch {} }
const ofd = openSync(out, 'w');
const efd = openSync(err, 'w');
const script = "Start-Process -FilePath 'D:\\WenJian\\NapCat\\launcher.bat' -WorkingDirectory 'D:\\WenJian\\NapCat' -ArgumentList '1766131793' -Verb RunAs";
console.log('script:', script);
const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
  cwd: 'D:\\WenJian\\NapCat',
  stdio: ['ignore', ofd, efd],
  windowsHide: true,
});
child.on('error', (e) => console.log('spawn error:', e.message));
child.on('close', (code) => console.log('powershell exit:', code));
await new Promise((r) => setTimeout(r, 8000));
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return '(no file)'; } };
console.log('--- stdout ---\n' + read(out));
console.log('--- stderr ---\n' + read(err));
