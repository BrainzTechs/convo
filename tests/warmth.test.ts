import { describe, expect, test } from 'claude-code/testing'
import { coldToast, left, ttlOf, warmthOf, warmthRows } from '../hooks/warmth.ts'
import { contextNodes } from '../hooks/panel.ts'
import { emptyLedger } from '../hooks/ledger.ts'

const T0 = 10_000_000
const last = { at: T0, model: 'claude-opus-5-5', input: 66_000, output: 1000 }
const hour = { ttl: '1h' as const, from: 'plan' as const }
// Dollars a list-price unit: Opus cache reads at $0.50 a million (0.1 × 5 units a token)
const RATE = 0.5 / 1e6 / 0.5

describe('how warm the prompt cache is', () => {
  test('the lifetime: the setting, else an hour once seen, else by plan', () => {
    expect(ttlOf({ setting: '5m', seenHour: true, subscription: true })).toEqual({ ttl: '5m', from: 'setting' })
    expect(ttlOf({ setting: '', seenHour: true, subscription: false })).toEqual({ ttl: '1h', from: 'seen' })
    expect(ttlOf({ setting: 'odd', seenHour: false, subscription: true })).toEqual({ ttl: '1h', from: 'plan' })
    expect(ttlOf({ seenHour: false, subscription: false })).toEqual({ ttl: '5m', from: 'plan' })
  })

  test('warm, then cooling in its last five minutes, then cold; priced either side', () => {
    const warm = warmthOf(last, T0 + 22 * 60_000, hour, RATE)
    expect(warm).toMatchObject({ state: 'warm', ms: 38 * 60_000, tokens: 67_000 })
    expect(Math.abs((warm.warmUsd ?? 0) - 0.0335) < 1e-9 && Math.abs((warm.coldUsd ?? 0) - 0.41875) < 1e-9).toBe(true)
    expect(warmthOf(last, T0 + 56 * 60_000, hour, RATE).state).toBe('cooling')
    expect(warmthOf(last, T0 + 80 * 60_000, hour, RATE)).toMatchObject({ state: 'cold', ms: 20 * 60_000 })
    // Five minutes: its last minute is cooling
    expect(warmthOf(last, T0 + 4.5 * 60_000, { ttl: '5m', from: 'plan' }, RATE).state).toBe('cooling')
    // No rate yet: tokens only
    expect(warmthOf(last, T0, hour, 0).coldUsd).toBeUndefined()
    expect([left(50_000), left(260_000), left(38 * 60_000), left(130 * 60_000)]).toEqual(['50s', '4m20s', '38m', '2h10m'])
  })

  test('the lines and the toast', () => {
    expect(warmthRows(warmthOf(last, T0 + 22 * 60_000, hour, RATE))).toEqual([
      { text: '  prompt cache: warm · goes cold in 38m (1h cache, by plan)', tone: 'good' },
      { text: '    a send now reads 67k from the cache (~$0.03); once cold it re-caches it (~$0.42)', tone: 'dim' },
    ])
    const cold = warmthOf(last, T0 + 80 * 60_000, { ttl: '1h', from: 'seen' }, RATE)
    expect(warmthRows(cold).map(r => [r.text, r.tone])).toEqual([
      ['  prompt cache: cold for 20m (1h cache, seen)', 'warn'],
      ['    the next send writes 67k to the cache again (~$0.42) instead of reading it (~$0.03)', 'dim'],
    ])
    expect(coldToast(cold)).toBe('the prompt cache went cold: your next message writes 67k to it again (~$0.42 instead of ~$0.03)')
    expect(coldToast(warmthOf({ ...last, input: 5000 }, T0 + 80 * 60_000, hour, RATE))).toBeUndefined()
    expect(coldToast(warmthOf(last, T0, hour, RATE))).toBeUndefined()
  })

  test('the Context tab shows it under the gauge', () => {
    const l = { ...emptyLedger(0), requests: 3, read: 60_000, last: { main: last }, autoCompactAt: 967_000, cache: { ...hour, rate: RATE } }
    const text = contextNodes(l, 100, T0 + 22 * 60_000).map(n => n.text)
    expect(text[0]).toMatch(/66k \/ 967k$/)
    expect(text[1]).toBe('  prompt cache: warm · goes cold in 38m (1h cache, by plan)')
  })
})
