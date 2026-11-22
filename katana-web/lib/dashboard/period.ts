const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 「直近30日」をrolling 30 daysとして扱う（calendar monthではない）。
 * periodEnd = now, periodStart = now - 30日。
 * getSoldCountの半開区間 [periodStart, periodEnd) にそのまま渡す想定。
 */
export function getRolling30DaysPeriod(now: Date = new Date()): {
  periodStart: Date;
  periodEnd: Date;
} {
  return {
    periodStart: new Date(now.getTime() - THIRTY_DAYS_MS),
    periodEnd: now,
  };
}
