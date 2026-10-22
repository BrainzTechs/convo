import { describe, expect, test } from 'claude-code/testing'
import { addRequest, addTurn, dayOf, daysFromHistory, historyText, sumDays, weekLine, type DayTotals } from '../hooks/spend.ts'

const NOW = new Date(2026, 9, 23, 12).getTime()
const DAY = 24 * 60 * 60_000

describe('usage history', () => {
  test("a session's requests and turns add up by day, cost where Claude Code says", () => {
    const days: Record<string, DayTotals> = {}
    addRequest(days, '2026-10-23', { uncached: 2, read: 40_000, write: 500, output: 120 })
    addRequest(days, '2026-10-23', { uncached: 2, read: 40_500, write: 300, output: 80 })
    addTurn(days, '2026-10-23', 0.12)
    addTurn(days, '2026-10-23', undefined)
    expect(days['2026-10-23']).toEqual({ turns: 2, uncached: 4, read: 80_500, write: 800, output: 200, usd: 0.12, uncosted: 1 })
    expect(dayOf(NOW)).toBe('2026-10-23')
  })

  test("git's turn files: by day, a fork's shared turns once, subagents' tokens but not their turns, sessions with their own record left out", () => {
    const at = (d: number): string => new Date(NOW - d * DAY).toISOString()
    const file = (turnId: string, session: string, d: number, inTok: number, agent = false): string =>
      [`turnId: ${turnId}`, `session: ${session}`, ...(agent ? ['agent: a1'] : []), `at: ${at(d)}`, `usage: { in: 2, out: 10, cacheRead: ${inTok}, cacheWrite: 100 }`].join('\n')
    const lines = [file('t1', 'A', 1, 1000), file('t2', 'A', 1, 2000), file('t1', 'A', 1, 1000), file('t3', 'A', 1, 500, true), file('t4', 'B', 0, 9000), file('t5', 'C', 0, 7000)].join('\n')
    const days = daysFromHistory(lines, new Set(['C']))
    expect(days[dayOf(NOW - DAY)]).toEqual({ turns: 2, uncached: 6, read: 3500, write: 300, output: 30, sessions: 1, uncosted: 2 })
    expect(days[dayOf(NOW)]).toEqual({ turns: 1, uncached: 2, read: 9000, write: 100, output: 10, sessions: 1, uncosted: 1 })
  })

  test('the week in a line, and fourteen days in the context tool', () => {
    const today = dayOf(NOW)
    const yesterday = dayOf(NOW - DAY)
    const fromGit = { [yesterday]: { turns: 30, uncached: 60, read: 2_000_000, write: 90_000, output: 20_000, sessions: 3, uncosted: 30 } }
    const mine = { [today]: { turns: 5, uncached: 10, read: 400_000, write: 20_000, output: 3000, usd: 0.84 } }
    const days = sumDays([fromGit, mine])
    expect(weekLine(days, NOW)).toBe('  this project, last 7 days: $0.84 for the turns convo priced (30 from before it did), 35 turns, 2.5M in (96% from cache)')
    expect(historyText(days, NOW).split('\n')).toEqual([
      'This project, by day (tokens in: from cache / written to it / uncached; cost where Claude Code reported it):',
      `  ${today}: $0.84, 5 turns in 1 session, 420k in (400k / 20k / 10), 3.0k out`,
      `  ${yesterday}: 30 turns in 3 sessions, 2.1M in (2.0M / 90k / 60), 20k out`,
    ])
    expect(weekLine({}, NOW)).toBeUndefined()
    expect(historyText({}, NOW)).toBe('No use recorded in this project in the last 14 days.')
  })
})
