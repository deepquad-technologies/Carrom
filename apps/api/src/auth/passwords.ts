import bcrypt from 'bcryptjs';
import { PASSWORD_RULES } from '@carrom/config';
import { badRequest } from '../lib/errors.js';

const COST = 12;

export async function hashPassword(plain: string): Promise<string> {
  assertStrongEnough(plain);
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string | null): Promise<boolean> {
  if (!hash) return false;
  return bcrypt.compare(plain, hash);
}

export function assertStrongEnough(plain: string): void {
  if (plain.length < PASSWORD_RULES.minLength) {
    throw badRequest(
      `Password must be at least ${PASSWORD_RULES.minLength} characters`,
      'weak_password',
    );
  }
  if (plain.length > PASSWORD_RULES.maxLength) {
    throw badRequest('That password is too long', 'weak_password');
  }
  if (!PASSWORD_RULES.pattern.test(plain)) {
    throw badRequest('Password needs at least one letter and one number', 'weak_password');
  }
}
