/** How long UI-cached Supabase / session data stays fresh before a background refetch. */
export const UI_CACHE_TTL_MS = 60_000;

/**
 * Home-page Firebase report session cache: keep until upload or explicit refresh.
 * Date-range changes only recompute analysis; they do not need a new report fetch.
 */
export const REPORT_SESSION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
