'use strict';
// DB layer: every method is one atomic SQL function (supabase/migrations/0002_vkin_entitlements.sql) called
// with the service-role client. All time is DB time. PT* SQLSTATEs map to contract errors.

const { ApiError } = require('./errors');

const PT_ERRORS = {
  PT400: [400, 'bad_request'],
  PT402: [402, 'no_minutes'],
  PT404: [404, 'not_found'],
  PT409: [409, 'lease_active'],
};

function mapError(error) {
  const hit = error && PT_ERRORS[error.code];
  if (hit) return new ApiError(hit[0], hit[1]);
  // Never include request data; the DB message names the function failure only.
  const err = new Error(`db error ${error && error.code ? error.code : ''}`.trim());
  err.dbCode = error && error.code;
  return err;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function createDb(supabase) {
  async function rpc(fn, args) {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw mapError(error);
    return data;
  }

  return {
    async ensureEntitlement(userId) {
      return Boolean(await rpc('vkin_ensure_entitlement', { p_user: userId }));
    },
    async me(userId) {
      const d = await rpc('vkin_me', { p_user: userId });
      return {
        trialSeconds: num(d.trialSeconds),
        purchasedSeconds: num(d.purchasedSeconds),
        usedSeconds: num(d.usedSeconds),
        remainingSeconds: num(d.remainingSeconds),
        activeLease: d.activeLease || null,
      };
    },
    async startLease(userId, device) {
      const d = await rpc('vkin_start_lease', { p_user: userId, p_device: device });
      return { leaseId: d.leaseId, remainingSeconds: num(d.remainingSeconds), chargedSeconds: num(d.chargedSeconds), expired: Array.isArray(d.expired) ? d.expired : [] };
    },
    async billLease(userId, leaseId) {
      const d = await rpc('vkin_bill_lease', { p_user: userId, p_lease: leaseId });
      return { remainingSeconds: num(d.remainingSeconds), status: d.status, billedSeconds: num(d.billedSeconds), reason: d.reason || null };
    },
    async stopLease(userId, leaseId) {
      const d = await rpc('vkin_stop_lease', { p_user: userId, p_lease: leaseId });
      return { remainingSeconds: num(d.remainingSeconds), status: d.status, billedSeconds: num(d.billedSeconds), reason: d.reason || null };
    },
    async leaseState(userId, leaseId) {
      const d = await rpc('vkin_lease_state', { p_user: userId, p_lease: leaseId });
      return { status: d.status, remainingSeconds: num(d.remainingSeconds), usableSeconds: num(d.usableSeconds) };
    },
    async expireLeases() {
      const d = await rpc('vkin_expire_leases', {});
      return Array.isArray(d) ? d : [];
    },
    async recordUsage({ userId, leaseId, provider, model, unitsIn, unitsOut, costUsd }) {
      await rpc('vkin_record_usage', {
        p_user: userId || null,
        p_lease: leaseId || null,
        p_provider: provider,
        p_model: model || '',
        p_units_in: unitsIn || 0,
        p_units_out: unitsOut || 0,
        p_cost_usd: Math.round((costUsd || 0) * 1e6) / 1e6,
      });
    },
    async spendTotals() {
      const d = (await rpc('vkin_spend_totals', {})) || {};
      return { nebius: num(d.nebius), gemini: num(d.gemini), deepgram: num(d.deepgram), geminiRequestsToday: num(d.geminiRequestsToday) };
    },
    async userSpend(userId) {
      const d = (await rpc('vkin_user_spend', { p_user: userId })) || {};
      return {
        nebius: num(d.nebius), gemini: num(d.gemini), deepgram: num(d.deepgram),
        nebiusToday: num(d.nebiusToday), geminiRequestsToday: num(d.geminiRequestsToday),
      };
    },
  };
}

module.exports = { createDb, mapError };
