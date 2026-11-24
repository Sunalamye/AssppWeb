import { describe, expect, it } from 'vitest';
import { acceptChunk, parseContentLength, parseContentRange } from '../src/domain/downloadPolicy.js';

describe('HTTP-to-model numeric boundaries', () => {
  it.each([null, '', 'bytes */8', 'bytes -1-3/8', 'bytes 0-3/8tail', 'bytes 0-3/*', 'bytes 0-3/9007199254740993'])(
    'rejects an absent, malformed, or unsafe Content-Range: %s',
    (value) => expect(parseContentRange(value)).toBeNull(),
  );

  it('parses a byte range without rounding large integers', () => {
    expect(parseContentRange('bytes 0-3/8')).toEqual({ start: 0, end: 3, total: 8 });
    expect(parseContentRange('bytes 0-3/9007199254740991')).toEqual({
      start: 0,
      end: 3,
      total: Number.MAX_SAFE_INTEGER,
    });
  });

  it.each([null, '', '-1', '8tail', '1.5', 'NaN', 'Infinity', '9007199254740993'])(
    'rejects an invalid or unknown Content-Length: %s',
    (value) => expect(parseContentLength(value)).toBeNull(),
  );

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'keeps the natural-number model boundary for an invalid size %s',
    (invalid) => {
      const valid = {
        status: 206,
        validRange: true,
        start: 0,
        end: 3,
        total: 8,
        expectedStart: 0,
        expectedEnd: 3,
        expectedTotal: 8,
        actualBytes: 4,
      };
      for (const field of ['start', 'end', 'total', 'expectedStart', 'expectedEnd', 'expectedTotal', 'actualBytes']) {
        expect(acceptChunk({ ...valid, [field]: invalid })).toBe(false);
      }
    },
  );
});
