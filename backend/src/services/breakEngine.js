// services/breakEngine.js
//
// Pure(ish) punch-sequence logic, shared by the attendance controller and
// the auto clock-out job. Break durations are read from `break_policies` so
// admins can reconfigure breaks without a code change.

import { supabase } from '../config/supabase.js';

let policyCache = null;
let policyCacheAt = 0;
const POLICY_CACHE_MS = 60_000; // admin edits to break_policies apply within a minute

export async function getBreakPolicies() {
  const now = Date.now();
  if (policyCache && now - policyCacheAt < POLICY_CACHE_MS) return policyCache;

  const { data, error } = await supabase
    .from('break_policies')
    .select('name, label, duration_minutes, sequence')
    .eq('active', true)
    .order('sequence', { ascending: true });
  if (error) throw error;

  policyCache = data || [];
  policyCacheAt = now;
  return policyCache;
}

export function invalidateBreakPolicyCache() {
  policyCache = null;
}

/**
 * Given the punches recorded so far (sorted by sequence) and the active
 * break policy list, decide what the NEXT punch means.
 *
 * Returns one of:
 *   { punch_type: 'in',  break_type: null,        is_final: false, meaning: 'shift_start' }
 *   { punch_type: 'out', break_type: '<name>',     is_final: false, meaning: '<name>_start' }
 *   { punch_type: 'in',  break_type: '<name>',     is_final: false, meaning: '<name>_end' }
 *   { punch_type: 'out', break_type: null,         is_final: true,  meaning: 'final_out' }
 *   { punch_type: null,  meaning: 'already_finalized' }
 */
export function getNextAction(punches, policies) {
  if (!punches || punches.length === 0) {
    return { punch_type: 'in', break_type: null, is_final: false, meaning: 'shift_start' };
  }

  const last = punches[punches.length - 1];

  if (last.is_final) {
    return { punch_type: null, break_type: null, is_final: true, meaning: 'already_finalized' };
  }

  if (last.punch_type === 'in') {
    // How many breaks have already been STARTED (i.e. how many break OUTs
    // exist) so far this day?
    const breaksStarted = punches.filter(p => p.punch_type === 'out' && p.break_type).length;
    if (breaksStarted < policies.length) {
      const next = policies[breaksStarted];
      return { punch_type: 'out', break_type: next.name, is_final: false, meaning: `${next.name}_start` };
    }
    return { punch_type: 'out', break_type: null, is_final: true, meaning: 'final_out' };
  }

  // last.punch_type === 'out' and not final → that OUT started a break;
  // the matching IN ends that same break.
  return { punch_type: 'in', break_type: last.break_type, is_final: false, meaning: `${last.break_type}_end` };
}

export function isOnBreak(punches) {
  if (!punches || punches.length === 0) return false;
  const last = punches[punches.length - 1];
  return last.punch_type === 'out' && !last.is_final;
}

export function currentBreakType(punches) {
  return isOnBreak(punches) ? punches[punches.length - 1].break_type : null;
}

/**
 * Credited break minutes = sum of the FIXED policy duration for every break
 * that has been fully closed (has both its OUT and its matching IN) among
 * the given punches. Never derived from actual elapsed time.
 */
export function creditedBreakMinutes(punches, policies) {
  const durationByName = Object.fromEntries(policies.map(p => [p.name, p.duration_minutes]));
  const closedBreakTypes = new Set();
  for (const p of punches) {
    if (p.punch_type === 'in' && p.break_type && !p.is_final) {
      closedBreakTypes.add(p.break_type);
    }
  }
  let total = 0;
  for (const type of closedBreakTypes) total += durationByName[type] || 0;
  return total;
}