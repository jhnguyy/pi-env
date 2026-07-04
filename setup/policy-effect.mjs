import { Effect } from 'effect';
import { deriveSetupPolicy } from './policy.mjs';

export function deriveSetupPolicyEffect(env = process.env) {
  return Effect.sync(() => deriveSetupPolicy(env));
}
