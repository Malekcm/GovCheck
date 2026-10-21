import type { AppConfig } from '../config';
import { HttpProblem } from '../app';

export function emailAllowed(config: AppConfig, email: string | undefined): boolean {
  if (!config.allowedEmailDomains.length) return true;
  const parts = (email ?? '').toLowerCase().split('@');
  return parts.length === 2 && !!parts[0] && config.allowedEmailDomains.includes(parts[1]);
}

export function requireAllowedEmail(config: AppConfig, email: string | undefined) {
  if (!emailAllowed(config, email)) throw new HttpProblem(403, `Team access is limited to invited ${config.allowedEmailDomains.map(d=>`@${d}`).join(', ')} addresses.`);
}
