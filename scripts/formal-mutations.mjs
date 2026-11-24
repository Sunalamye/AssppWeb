import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from '../backend/node_modules/typescript/lib/typescript.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const rows = readFileSync(process.argv[2], 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
const mutations = [
  [
    'stale worker accepted',
    'backend/src/domain/downloadPolicy.ts',
    'if (!currentGeneration) return state;',
    '',
    'lifecycle',
  ],
  [
    'completed task restarted',
    'backend/src/domain/downloadPolicy.ts',
    "state === 'pending' ? 'downloading'",
    "state === 'pending' || state === 'completed' ? 'downloading'",
    'lifecycle',
  ],
  [
    'ignored Range accepted',
    'backend/src/domain/downloadPolicy.ts',
    'input.status === 206',
    '(input.status === 206 || input.status === 200)',
    'chunk',
  ],
  [
    'short chunk accepted',
    'backend/src/domain/downloadPolicy.ts',
    'input.actualBytes === input.expectedEnd - input.expectedStart + 1',
    'input.actualBytes <= input.expectedEnd - input.expectedStart + 1',
    'chunk',
  ],
  [
    'different resource length accepted',
    'backend/src/domain/downloadPolicy.ts',
    'input.total === input.expectedTotal',
    'true',
    'chunk',
  ],
  ['download action ignored', 'frontend/src/domain/downloadPolicy.ts', 'facts.actionPresent ||', '', 'download'],
  [
    'download denial ignored',
    'frontend/src/domain/downloadPolicy.ts',
    "facts.status === 'rejected' ||",
    '',
    'download',
  ],
  [
    'contradictory items accepted',
    'frontend/src/domain/downloadPolicy.ts',
    "facts.failure === 'none' && facts.message === 'none'",
    'true',
    'download',
  ],
  ['auth action ignored', 'frontend/src/domain/authPolicy.ts', 'facts.actionPresent ||', '', 'auth'],
  [
    'authentication without DSID',
    'frontend/src/domain/authPolicy.ts',
    'facts.httpOk && facts.hasToken && facts.hasDsid',
    'facts.httpOk && facts.hasToken',
    'auth',
  ],
  [
    'unbounded credential retry',
    'frontend/src/domain/authPolicy.ts',
    "facts.failure === 'retryCredentials' && facts.firstAttempt",
    "facts.failure === 'retryCredentials'",
    'auth',
  ],
];

async function loadModule(source) {
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
}
function actual(module, suite, input) {
  switch (suite) {
    case 'lifecycle':
      return module.transitionDownload(input.state, input.event, input.currentGeneration);
    case 'chunk':
      return module.acceptChunk(input);
    case 'download':
      return module.decideDownloadResponse(input);
    case 'auth':
      return module.decideAuthResponse(input);
    default:
      throw new Error(`Unknown mutation suite ${suite}`);
  }
}
const killed = [];
for (const [name, file, before, after, suite] of mutations) {
  const source = readFileSync(`${root}/${file}`, 'utf8');
  assert.equal(source.split(before).length, 2, `Mutation anchor changed: ${name}`);
  const relevant = rows.filter((row) => row.suite === suite);
  assert(relevant.length > 0, `Missing Lean oracle suite: ${suite}`);
  const original = await loadModule(source);
  for (const row of relevant) {
    assert.deepEqual(actual(original, suite, row.input), row.expected, `Original failed before mutation: ${name}`);
  }
  const mutant = await loadModule(source.replace(before, after));
  const witness = relevant.find((row) => actual(mutant, suite, row.input) !== row.expected);
  assert(witness, `Mutation survived the Lean oracle: ${name}`);
  killed.push({ name, witness: witness.input });
}
console.log(
  JSON.stringify({ mutationResult: 'pass', killed: killed.length, total: mutations.length, witnesses: killed }),
);
