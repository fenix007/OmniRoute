// Accept HTTP delay-seconds and the three HTTP-date wire formats, never JS date shortcuts.
export function parseRetryAfterHeader(
  value: string | null | undefined,
  now = Date.now()
): number | null {
  const text = value?.trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const milliseconds = Number(text) * 1000;
    return Number.isSafeInteger(milliseconds) ? milliseconds : null;
  }
  const weekday = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)";
  const month = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
  const clock = "\\d{2}:\\d{2}:\\d{2}";
  const httpDate = new RegExp(
    `^(?:${weekday}, \\d{2} ${month} \\d{4} ${clock} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \\d{2}-${month}-\\d{2} ${clock} GMT|${weekday} ${month} (?: \\d|\\d{2}) ${clock} \\d{4})$`
  );
  if (!httpDate.test(text)) return null;
  const date = Date.parse(text.endsWith("GMT") ? text : `${text} GMT`);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
