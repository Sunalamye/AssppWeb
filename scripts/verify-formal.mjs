import { createHash } from 'node:crypto';
import { mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const formal = resolve(root, 'formal');
const build = resolve(formal, '.lake', 'verification');
const receipt = resolve(build, 'verified.json');
// A failed rerun must not leave a previous run's success receipt in place.
rmSync(receipt, { force: true });
const lean = process.env.ASSPP_LEAN || 'lean';
const expectedVersion = readFileSync(resolve(formal, 'lean-toolchain'), 'utf8').trim().split(':v')[1];
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: 'inherit', ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed: ${result.error?.message ?? result.status}`);
  }
  return result;
}

function sourceFiles() {
  const files = [
    'Dockerfile',
    '.dockerignore',
    '.prettierrc.json',
    '.prettierignore',
    'package.json',
    'package-lock.json',
    'frontend/package.json',
    'frontend/package-lock.json',
    'frontend/tsconfig.json',
    'frontend/vite.config.ts',
    'frontend/vitest.config.ts',
    'frontend/index.html',
    'backend/package.json',
    'backend/package-lock.json',
    'backend/tsconfig.json',
    'backend/vitest.config.ts',
    'wrangler.jsonc',
  ];
  const walk = (directory) => {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      if (['node_modules', 'dist', '.lake'].includes(entry.name)) continue;
      const name = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(name);
      else if (!/\.(md|olean|ilean|c)$/.test(name)) files.push(name);
    }
  };
  for (const directory of [
    'frontend/src',
    'frontend/tests',
    'frontend/public',
    'backend/src',
    'backend/tests',
    'proof-helper',
    'scripts',
    'formal',
    'container',
    'cloudflare/src',
  ])
    walk(directory);
  return files.sort();
}
const inputs = sourceFiles();
const leanFiles = inputs.filter((name) => name.startsWith('formal/') && name.endsWith('.lean'));
const hashInput = (name) =>
  createHash('sha256')
    .update(readFileSync(resolve(root, name)))
    .digest('hex');
const sourceHashes = Object.fromEntries(inputs.map((name) => [name, hashInput(name)]));
for (const name of leanFiles) {
  const source = readFileSync(resolve(root, name), 'utf8');
  if (/\b(sorry|admit|axiom|native_decide|unsafe|partial)\b/.test(source)) {
    throw new Error(`Untrusted proof escape or unfinished declaration in ${name}`);
  }
}
const version = run(lean, ['--version'], { cwd: formal, stdio: 'pipe' }).stdout.trim();
if (!version.includes(`version ${expectedVersion} `) && !version.includes(`version ${expectedVersion},`)) {
  throw new Error(`Wrong Lean toolchain: expected ${expectedVersion}, got ${version}`);
}
console.log(version);

mkdirSync(build, { recursive: true });
const env = { ...process.env, LEAN_PATH: formal };
run(lean, ['-o', resolve(build, 'Asspp.olean'), 'Asspp.lean'], { cwd: formal, env });
// Main imports exactly the freshly checked module, never a committed/generated oracle.
const oracleEnv = { ...process.env, LEAN_PATH: build };
const assurance = run(lean, ['Assurance.lean'], { cwd: formal, env: oracleEnv, stdio: 'pipe' }).stdout;
if (/sorryAx|Lean\.ofReduceBool|lcProof|failed|error:/i.test(assurance)) {
  throw new Error('Unexpected proof dependency or diagnostic in the kernel assurance output');
}
const theoremNames = [...readFileSync(resolve(formal, 'Asspp.lean'), 'utf8').matchAll(/^theorem\s+(\w+)/gm)].map(
  (match) => `Asspp.${match[1]}`,
);
if (theoremNames.length === 0 || theoremNames.some((name) => !assurance.includes(`'${name}'`))) {
  throw new Error('Every model theorem must appear in the kernel dependency audit');
}
writeFileSync(resolve(build, 'assurance.txt'), assurance);
console.log(assurance.trim());
run(lean, ['Main.lean'], { cwd: formal, env: oracleEnv });
const vectors = resolve(build, 'vectors.jsonl');
const fd = openSync(vectors, 'w');
try {
  run(lean, ['--run', 'Main.lean'], { cwd: formal, env: oracleEnv, stdio: ['ignore', fd, 'inherit'] });
} finally {
  closeSync(fd);
}
const tsxLoader = resolve(root, 'backend/node_modules/tsx/dist/loader.mjs');
// The loader executes the same production imports without the CLI's IPC server.
run(process.execPath, ['--import', tsxLoader, 'scripts/formal-differential.mts', vectors]);
run(process.execPath, ['scripts/test-helper.mjs', '-run', '^TestProvisionPolicyAgainstLean$'], {
  env: { ...process.env, ASSPP_FORMAL_VECTORS: vectors },
});
run(process.execPath, ['scripts/formal-mutations.mjs', vectors]);
run(process.execPath, ['scripts/formal-proof-mutations.mjs']);

if (JSON.stringify(sourceFiles()) !== JSON.stringify(inputs))
  throw new Error('Verification source set changed during the run');
for (const name of inputs) {
  if (hashInput(name) !== sourceHashes[name]) throw new Error(`Verification source changed during the run: ${name}`);
}
const oracleSha256 = createHash('sha256').update(readFileSync(vectors)).digest('hex');
writeFileSync(
  receipt,
  JSON.stringify(
    { verifiedAt: new Date().toISOString(), version, theoremCount: theoremNames.length, sourceHashes, oracleSha256 },
    null,
    2,
  ) + '\n',
);
console.log(
  'Formal verification passed: checked proofs, fresh Lean oracle, TypeScript/Go correspondence and mutations.',
);
