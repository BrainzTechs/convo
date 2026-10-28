import { describe, expect, test } from 'claude-code/testing'
import { beatText, decideActive, isInside, parseBeat, parseExclude, type Beat } from '../hooks/live.ts'

describe('the off switch', () => {
  test('parseExclude cleans paths', () => {
    expect(parseExclude(' ~/Downloads/ , ,/a/b,, ', '/h')).toEqual(['/h/Downloads', '/a/b'])
    expect(parseExclude(undefined, '/h')).toEqual([])
    expect(parseExclude('relative/x', '/h')).toEqual([]) // only absolute or ~ paths
  })

  test('isInside is the folder itself or anything under it, never a prefix of a name', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true)
    expect(isInside('/a/b/', '/a/b/c')).toBe(true)
    expect(isInside('/a/b', '/a/bc')).toBe(false)
    expect(isInside('/a/b', '/a')).toBe(false)
  })

  test('decideActive', () => {
    const base = { isInteractive: true, force: undefined, cwd: '/a/momopay/backend', exclude: [] }
    expect(decideActive(base)).toEqual({ active: true, why: '' })
    expect(decideActive({ ...base, isInteractive: false }).active).toBe(false)
    expect(decideActive({ ...base, isInteractive: false, force: '1' }).active).toBe(true)
    expect(decideActive({ ...base, exclude: ['/a/momopay'] }).active).toBe(false)
    expect(decideActive({ ...base, exclude: ['/a/momopay'], force: '1' }).active).toBe(false) // force never beats exclude
    expect(decideActive({ ...base, exclude: ['/a/momo'] }).active).toBe(true) // prefix trap
    expect(decideActive({ ...base, isInteractive: false }).why).toContain('not interactive')
    expect(decideActive({ ...base, exclude: ['/a/momopay'] }).why).toBe('excluded folder /a/momopay')
  })
})

describe('the heartbeat file', () => {
  test('parseBeat rejects what is not a v1 beat', () => {
    expect(parseBeat('1792913206856')).toBeUndefined() // the old bare timestamp
    expect(parseBeat('')).toBeUndefined()
    expect(parseBeat('{')).toBeUndefined()
    expect(parseBeat('{"v":2}')).toBeUndefined()
  })

  test('a beat round-trips', () => {
    const b: Beat = { v: 1, at: 1792913206856, state: 'working', since: 1792913200000, prompt: 'migrate payments repo to sqlc', turns: 4, interactive: true, holds: ['/a/b'], holdsUnknown: 1 }
    expect(parseBeat(beatText(b))).toEqual(b)
  })
})
