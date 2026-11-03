import { describe, expect, it } from 'vitest'
import { measureScaling } from './scaling'

// The helper itself must tell the two growth rates apart, or the redaction tests built on it prove nothing.
const spin = (units: number) => { let x = 0; for (let i = 0; i < units; i++) x += i % 7; return x }
const quadratic = (text: string) => { let n = 0; for (let i = 0; i < text.length; i++) for (let j = 0; j < text.length; j += 1) n += (i ^ j) & 1; return n }

describe('measureScaling', () => {
  it('reports a linear scan as below the limit and a quadratic one as above it', () => {
    const make = (n: number) => 'a'.repeat(n)
    const linear = measureScaling(make, (t) => spin(t.length * 400), { small: 5000 })
    const slow = measureScaling(make, quadratic, { small: 300, minMs: 1 })
    expect(linear.ratio).toBeLessThan(linear.limit)
    expect(slow.ratio).toBeGreaterThan(slow.limit)
  })
})
