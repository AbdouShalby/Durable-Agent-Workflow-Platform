import { createHash } from 'node:crypto';

/** Milliseconds; reproducible equal jitter in [ceil(capped exponential / 2), capped exponential]. */
export function retryDelay(run: string, step: string, attempt: number, base: number, cap: number): number {
  if (![attempt, base, cap].every(Number.isSafeInteger) || attempt < 1 || attempt > 10 || base < 1 || cap < base || cap > 60000) {
    throw new Error('invalid retry policy');
  }
  const ceiling = Math.min(cap, base * 2 ** (attempt - 1));
  const floor = Math.ceil(ceiling / 2);
  const seed = createHash('sha256').update(JSON.stringify(['equal-jitter-v1', run, step, attempt])).digest().readUInt32BE();
  return floor + seed % (ceiling - floor + 1);
}
