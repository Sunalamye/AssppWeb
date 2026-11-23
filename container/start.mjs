import { spawn } from 'node:child_process';

// Keep the proof service on loopback. If either child exits, restart the whole
// container rather than leaving a healthy-looking frontend with broken auth.
const children = [
  spawn('/usr/local/bin/asspp-proof', [], { stdio: ['ignore', 'inherit', 'inherit'] }),
  spawn(process.execPath, ['dist/index.js'], { stdio: ['ignore', 'inherit', 'inherit'] }),
];
let stopping = false;
let exitCode = 0;
let timer;

function stop(code) {
  if (stopping) return;
  stopping = true;
  exitCode = code;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  timer = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
    process.exit(exitCode);
  }, 10_000);
  timer.unref();
}

for (const child of children) {
  child.on('error', () => {
    console.error('A required application process could not start.');
    stop(1);
  });
  child.on('exit', (code) => {
    stop(code || 1);
    if (children.every((process) => process.exitCode !== null || process.signalCode !== null)) {
      clearTimeout(timer);
      process.exit(exitCode);
    }
  });
}

process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
