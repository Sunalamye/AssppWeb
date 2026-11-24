import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const lean = process.env.ASSPP_LEAN || 'lean';
const source = readFileSync(resolve(root, 'formal/Asspp.lean'), 'utf8');
const directory = mkdtempSync(join(tmpdir(), 'asspp-proof-mutations-'));
function check(name, text) {
  const filename = join(directory, `${name}.lean`);
  writeFileSync(filename, text);
  const result = spawnSync(lean, [filename], {
    cwd: resolve(root, 'formal'),
    encoding: 'utf8',
    timeout: 120_000,
  });
  assert(!result.error, `Lean compiler could not run: ${result.error?.message}`);
  return { code: result.status, output: `${result.stdout}\n${result.stderr}` };
}

try {
  const original = check('Original', source);
  assert.equal(original.code, 0, `Unchanged model failed: ${original.output}`);
  const mutations = [
    ['stale worker guard removed', 'if workerEvent e && !current then s else', 'if false then s else'],
    ['authentication rejected status ignored', '|| f.rejectedStatus then .reject', 'then .reject'],
  ];
  for (const [index, [name, before, after]] of mutations.entries()) {
    assert.equal(source.split(before).length, 2, `Proof mutation anchor changed: ${name}`);
    const result = check(`Mutant${index}`, source.replace(before, after));
    assert.equal(result.code, 1, `Model mutation was not rejected by Lean: ${name}\n${result.output}`);
    assert.match(
      result.output,
      /error: unsolved goals/,
      `Expected proof failure, not an infrastructure error: ${name}`,
    );
    assert.doesNotMatch(result.output, /unknown module|unknown package|unexpected token|no such file/i);
  }
  console.log(JSON.stringify({ proofMutationResult: 'pass', killed: mutations.length, total: mutations.length }));
} finally {
  rmSync(directory, { recursive: true, force: true });
}
