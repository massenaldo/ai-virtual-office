/**
 * Asserts that `run` costs about linear time in the size of its input, without a wall-clock budget.
 *
 * A fixed millisecond limit measures the machine as much as the code: on a busy CPU the same linear scan took five times
 * longer than the limit allowed. What tells linear from quadratic cost is how the cost grows with the input, which load
 * affects far less. The input is made `factor` times larger: a linear cost grows about 8 times, a quadratic one 64 times.
 *
 * Time is the CPU time this process spends, not the wall clock, so a busy machine that preempts a long run (but lets a short
 * one finish inside its slice) does not skew the ratio. Each size is timed several times and the fastest run is kept, because
 * GC only ever adds time. Even so, a loaded machine makes a large input cost more per byte (GC and cache pressure): with every
 * core busy, a linear case here grew up to 27 times, never 64. The limit is 40, between what load does to linear code and
 * what quadratic code does.
 */
export function measureScaling(make: (n: number) => string, run: (text: string) => unknown, { small, factor = 8, trials = 5, minMs = 4 }: { small: number; factor?: number; trials?: number; minMs?: number }): { n: number; smallMs: number; largeMs: number; ratio: number; limit: number } {
  const fastest = (text: string) => {
    let best = Infinity
    for (let i = 0; i < trials; i++) {
      const t0 = process.cpuUsage()
      run(text)
      const used = process.cpuUsage(t0)
      best = Math.min(best, (used.user + used.system) / 1000)
    }
    return best
  }
  // A run of about a millisecond is mostly timer and GC noise. Grow the input until the smaller run is long enough to measure;
  // a cost that grows faster than linear reaches that size sooner, so this stays cheap for the inputs worth worrying about.
  let n = small
  run(make(n)) // let the engine warm up before timing
  let smallMs = fastest(make(n))
  for (let doublings = 0; smallMs < minMs && doublings < 6; doublings++) { n *= 2; smallMs = fastest(make(n)) }
  const largeMs = fastest(make(n * factor))
  const limit = 40
  return { n, smallMs, largeMs, ratio: largeMs / smallMs, limit }
}
