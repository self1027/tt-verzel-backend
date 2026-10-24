import { createHash } from 'node:crypto';
import { canonicalJson } from '../../audit/domain/cryptography.js';
import { AppError } from '../../../shared/http/app-error.js';

export function bidFingerprint(amountCents: bigint): string {
  if (typeof amountCents !== 'bigint' || amountCents < 1n || amountCents > 9223372036854775807n) {
    throw new AppError(400, 'INVALID_BID_AMOUNT', 'Bid amount must be a positive BIGINT');
  }
  return createHash('sha256').update('verzel:bid:place:v1\0')
    .update(canonicalJson({ amountCents: amountCents.toString() })).digest('hex');
}
