/* global module */
/* Pure formatting helpers for the budget dashboard (no DOM). */
(function (root) {
  const DAY = 86400000;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  /** USD with fixed decimals (default 4); '–' for missing/non-numeric input. */
  function usd(n, digits = 4) {
    const v = num(n);
    return v === null ? '–' : `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(digits)}`;
  }

  /** committed/cap as a percentage clamped to 0..100 (one decimal); 0 for a zero/invalid cap. */
  function pct(committed, cap) {
    const c = num(committed), k = num(cap);
    if (c === null || k === null || k <= 0) return 0;
    return Math.round(Math.max(0, Math.min(100, (c / k) * 100)) * 10) / 10;
  }

  /** Banner for warnLevel 50/75/90; null for no warning. tone: info | warn | err */
  function warnBanner(level) {
    const L = Number(level);
    if (L === 50) return { level: 50, tone: 'info', text: '50% of the budget is used.' };
    if (L === 75) return { level: 75, tone: 'warn', text: '75% of the budget is used. Slow down.' };
    if (L === 90) return { level: 90, tone: 'err', text: '90% of the budget is used. Close to the hard stop.' };
    return null;
  }

  /** Normalize {key: number | {usd, count}} to [{key, usd, count|null}] sorted by usd desc, then key. */
  function rows(byX) {
    if (!byX || typeof byX !== 'object' || Array.isArray(byX)) return [];
    return Object.entries(byX)
      .map(([key, v]) => {
        const o = v && typeof v === 'object';
        return { key, usd: num(o ? v.usd : v) || 0, count: o && num(v.count) !== null ? v.count : null };
      })
      .sort((a, b) => b.usd - a.usd || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** Cache hit rate as "NN%", or "n/a" when there were no calls. */
  function cacheRate(cache) {
    const h = num(cache && cache.hits) || 0, m = num(cache && cache.misses) || 0;
    return h + m > 0 ? `${Math.round((h / (h + m)) * 100)}%` : 'n/a';
  }

  /** True when refreshedAt (ISO string or epoch ms) is more than `days` old. Unknown/invalid counts as stale. */
  function isStale(refreshedAt, nowMs = Date.now(), days = 30) {
    const t = typeof refreshedAt === 'number' ? refreshedAt : refreshedAt ? Date.parse(refreshedAt) : NaN;
    return !Number.isFinite(t) || nowMs - t > days * DAY;
  }

  /** "org/Model-Name" -> "Model-Name"; '' for empty input. */
  function shortModel(id) {
    return id ? String(id).split('/').pop() : '';
  }

  /** Truncated session hash for display. */
  function shortId(id, n = 8) {
    const s = id == null ? '' : String(id);
    return s.length > n ? `${s.slice(0, n)}…` : s;
  }

  /** YYYY-MM-DD for an ISO string / epoch ms; '' if invalid. */
  function dateOnly(v) {
    const t = typeof v === 'number' ? v : v ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
  }

  const api = { usd, pct, warnBanner, rows, cacheRate, isStale, shortModel, shortId, dateOnly };
  root.BudgetView = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
