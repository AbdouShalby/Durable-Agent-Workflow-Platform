import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryDelay } from '../src/domain/retry.js';

test('retry policy has deterministic seeded jitter, exponential bounds and a hard cap', () => {
  const delays = new Set<number>();
  for (let run = 0; run < 100; run++) for (let attempt = 1; attempt <= 10; attempt++) {
    const value = retryDelay(String(run), 'normalize-incident', attempt, 200, 2000);
    assert.equal(value, retryDelay(String(run), 'normalize-incident', attempt, 200, 2000));
    const ceiling = Math.min(2000, 200 * 2 ** (attempt - 1));
    assert.ok(value >= Math.ceil(ceiling / 2) && value <= ceiling); delays.add(value);
  }
  assert.ok(delays.size > 100, 'identities must spread retries, not return a constant delay');
  for (const args of [[0, 200, 2000], [11, 200, 2000], [1, 200, 100], [1, 0, 2000], [1, 200, Infinity]]) {
    assert.throws(() => retryDelay('r', 's', args[0]!, args[1]!, args[2]!));
  }
});
