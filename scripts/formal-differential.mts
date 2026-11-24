import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { acceptChunk, transitionDownload } from '../backend/src/domain/downloadPolicy.ts';
import { decideAuthResponse } from '../frontend/src/domain/authPolicy.ts';
import { decideDownloadResponse } from '../frontend/src/domain/downloadPolicy.ts';

const filename = process.argv[2];
assert(filename, 'Expected a newly generated Lean oracle JSONL file');
const rows = readFileSync(filename, 'utf8').trim().split('\n');
const counts: Record<string, number> = {};
const unique: Record<string, Set<string>> = {};
for (const line of rows) {
  const row = JSON.parse(line);
  const { suite, input, expected } = row;
  let actual: unknown;
  switch (suite) {
    case 'lifecycle':
      actual = transitionDownload(input.state, input.event, input.currentGeneration);
      break;
    case 'download':
      actual = decideDownloadResponse(input);
      break;
    case 'auth':
      actual = decideAuthResponse(input);
      break;
    case 'chunk':
      actual = acceptChunk(input);
      break;
    case 'provision':
      // The Go test reads these same rows; never substitute a TS copy of the Go policy.
      counts[suite] = (counts[suite] ?? 0) + 1;
      continue;
    default:
      throw new Error(`Unknown oracle suite: ${suite}`);
  }
  assert.deepEqual(actual, expected, `Lean/TypeScript mismatch: ${line}`);
  counts[suite] = (counts[suite] ?? 0) + 1;
  if (suite !== 'chunk') {
    const key = JSON.stringify(input);
    unique[suite] ??= new Set();
    assert(!unique[suite].has(key), `Duplicate finite oracle input: ${line}`);
    unique[suite].add(key);
  }
}
assert.deepEqual(counts, { lifecycle: 112, download: 576, auth: 3072, provision: 16, chunk: 48645 });

// JS values with no natural-number representation cannot enter the Lean domain.
const valid = {
  status: 206,
  validRange: true,
  start: 0,
  end: 3,
  total: 4,
  expectedStart: 0,
  expectedEnd: 3,
  expectedTotal: 4,
  actualBytes: 4,
};
let representationChecks = 0;
for (const field of ['start', 'end', 'total', 'expectedStart', 'expectedEnd', 'expectedTotal', 'actualBytes']) {
  for (const invalid of [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(acceptChunk({ ...valid, [field]: invalid }), false, `${field} accepted ${invalid}`);
    representationChecks++;
  }
}
console.log(JSON.stringify({ result: 'pass', counts, representationChecks }));
