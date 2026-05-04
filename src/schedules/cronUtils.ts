import { CronExpressionParser } from "cron-parser";

/** Lịch một lần / trễ phút — lưu trong cron_expression, worker tắt sau khi chạy. */
export function isOneShotCronExpression(cronExpression: string): boolean {
  const x = cronExpression.trim().toLowerCase();
  return x.startsWith("@once:") || x.startsWith("@in:");
}

const MAX_DELAY_MINUTES = 525_600; // 1 năm

/** Chuẩn hoá 5-field cron (phút …) thành 6-field (giây phút …) cho cron-parser v5. */
export function normalizeCronExpression(expr: string): string {
  const t = expr.trim().replace(/\s+/g, " ");
  const parts = t.split(" ");
  if (parts.length === 5) return `0 ${t}`;
  return t;
}

export function computeNextRunAtIso(
  cronExpression: string,
  timezone: string,
  fromDate?: Date,
): string | null {
  const raw = cronExpression.trim();
  const low = raw.toLowerCase();
  if (low.startsWith("@once:")) {
    const rest = raw.slice(6).trim();
    const t = Date.parse(rest);
    if (Number.isNaN(t)) return null;
    const target = new Date(t);
    const ref = fromDate ?? new Date();
    if (target.getTime() <= ref.getTime()) return null;
    return target.toISOString();
  }
  if (low.startsWith("@in:")) {
    const rest = raw.slice(4).trim();
    const mins = Number(rest);
    if (!Number.isFinite(mins) || mins < 1 || mins > MAX_DELAY_MINUTES) return null;
    const ref = fromDate ?? new Date();
    return new Date(ref.getTime() + mins * 60_000).toISOString();
  }
  try {
    const expr = normalizeCronExpression(cronExpression);
    const cron = CronExpressionParser.parse(expr, {
      tz: (timezone || "UTC").trim(),
      currentDate: fromDate ?? new Date(),
    });
    return cron.next().toDate().toISOString();
  } catch {
    return null;
  }
}

export function isValidCronExpression(cronExpression: string, timezone: string): boolean {
  return computeNextRunAtIso(cronExpression, timezone) !== null;
}
