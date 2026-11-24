import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../proof-helper', import.meta.url));
const command = process.env.ASSPP_GO || 'go';
const version = spawnSync(command, ['version'], { encoding: 'utf8' });
if (version.status !== 0 || !/^go version go\d/.test(version.stdout || '')) {
  console.error('A Go compiler is required. Set ASSPP_GO to its executable path.');
  process.exit(1);
}
console.log(version.stdout.trim());
// These are the actual production HTTP service, validation and decision modules.
// Only native loading is excluded; runtime.go is built/tested by the Docker stage.
const files = [
  'contracts.go',
  'server.go',
  'diagnostics.go',
  'validation.go',
  'provision_policy.go',
  ...readdirSync(directory)
    .filter((name) => name.endsWith('_test.go'))
    .sort(),
];
const requireLeanComparison = Boolean(process.env.ASSPP_FORMAL_VECTORS);
const result = spawnSync(
  command,
  ['test', '-race', ...(requireLeanComparison ? ['-json'] : []), ...files, '-count=1', ...process.argv.slice(2)],
  {
    cwd: directory,
    encoding: 'utf8',
    stdio: requireLeanComparison ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    env: process.env,
  },
);
if (result.error) console.error(result.error.message);
if (requireLeanComparison) {
  if (result.stdout) process.stdout.write(result.stdout);
  let compared = false;
  let skipped = false;
  try {
    for (const line of (result.stdout || '').trim().split('\n').filter(Boolean)) {
      const event = JSON.parse(line);
      if (event.Test !== 'TestProvisionPolicyAgainstLean') continue;
      if (event.Action === 'pass') compared = true;
      if (event.Action === 'skip') skipped = true;
    }
  } catch {
    console.error('Could not verify the Go test execution events.');
    process.exit(1);
  }
  if (!compared || skipped) {
    console.error(
      'The Lean comparison must execute and pass TestProvisionPolicyAgainstLean; a missing or skipped test is not verification.',
    );
    process.exit(1);
  }
}
process.exit(result.status ?? 1);
