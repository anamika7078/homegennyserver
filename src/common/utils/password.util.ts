import { BadRequestException } from '@nestjs/common';

export const STRONG_PASSWORD_REGEX =
  /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&#\-_])[A-Za-z\d@$!%*?&#\-_]{8,72}$/;

export function assertStrongPassword(password: string): void {
  if (!STRONG_PASSWORD_REGEX.test(password)) {
    throw new BadRequestException(
      'Password must be 8-72 characters long and contain at least one uppercase letter, one lowercase letter, one number, and one special symbol (@, $, !, %, *, ?, &, #, -, _)',
    );
  }
}
