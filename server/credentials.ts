import { randomInt } from 'node:crypto';
import { ServiceError } from './errors.js';
import { escapeMarkdown } from 'discord.js';
import {
  DEFAULT_CREDENTIAL_MESSAGE_TEMPLATE,
  MAX_CREDENTIAL_MESSAGE_LENGTH,
  renderCredentialMessage,
} from './credential-message.js';

export const DEFAULT_PASSWORD_LENGTH = 12;
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 64;
export const DEFAULT_PASSWORD_EXCLUDE_AMBIGUOUS = true;

export interface PasswordOptions {
  password_length?: number;
  password_exclude_ambiguous?: boolean;
}

export interface CredentialMessageOptions {
  credential_message_template?: string;
  jellyfin_public_url?: string;
  jellyfin_url?: string;
}

/** Escape only the transport representation; the encrypted/admin message stays plain text. */
export function discordCredentialContent(message: string): string {
  if (
    typeof message !== 'string' ||
    !message ||
    message.length > MAX_CREDENTIAL_MESSAGE_LENGTH ||
    /\p{C}/u.test(message.replaceAll(/\r?\n/g, ''))
  )
    throw new ServiceError('Credentials could not be formatted for delivery.');
  const content = escapeMarkdown(message, {
    maskedLink: true,
    heading: true,
    bulletedList: true,
    numberedList: true,
  });
  if (content.length > MAX_CREDENTIAL_MESSAGE_LENGTH)
    throw new ServiceError('The account message is too long after formatting for Discord.');
  return content;
}

export function accountCredentialMessage(
  options: CredentialMessageOptions,
  username: string,
  password: string,
): string {
  try {
    const message = renderCredentialMessage(
      options.credential_message_template ?? DEFAULT_CREDENTIAL_MESSAGE_TEMPLATE,
      {
        username,
        password,
        server_url:
          options.jellyfin_public_url || options.jellyfin_url || 'https://jellyfin.example.test',
      },
    );
    discordCredentialContent(message);
    return message;
  } catch (error) {
    throw new ServiceError((error as Error).message);
  }
}

/** Leave room for the longest supported new username and password before saving settings. */
export function validateCredentialMessageOptions(options: CredentialMessageOptions): void {
  try {
    accountCredentialMessage(options, '`'.repeat(128), 'A'.repeat(MAX_PASSWORD_LENGTH));
  } catch (error) {
    throw new ServiceError((error as Error).message);
  }
}

export function validatePasswordOptions(options: PasswordOptions): void {
  const length =
    options.password_length === undefined ? DEFAULT_PASSWORD_LENGTH : options.password_length;
  if (!Number.isInteger(length) || length < MIN_PASSWORD_LENGTH || length > MAX_PASSWORD_LENGTH)
    throw new ServiceError('Password length must be a whole number between 12 and 64.');
  if (
    options.password_exclude_ambiguous !== undefined &&
    typeof options.password_exclude_ambiguous !== 'boolean'
  )
    throw new ServiceError('password_exclude_ambiguous must be a boolean.');
}

/** Cryptographic, alphanumeric passwords; guaranteed upper/lower/digit without modulo bias. */
export function generatePassword(options: PasswordOptions = {}): string {
  validatePasswordOptions(options);
  const length = options.password_length ?? DEFAULT_PASSWORD_LENGTH;
  const excludeAmbiguous = options.password_exclude_ambiguous ?? DEFAULT_PASSWORD_EXCLUDE_AMBIGUOUS;
  const keep = (value: string) => (excludeAmbiguous ? value.replace(/[0Oo1IilL]/g, '') : value);
  const upper = keep('ABCDEFGHIJKLMNOPQRSTUVWXYZ');
  const lower = keep('abcdefghijklmnopqrstuvwxyz');
  const digits = keep('0123456789');
  const all = upper + lower + digits;
  const choose = (values: string) => values[randomInt(values.length)]!;
  const characters = [choose(upper), choose(lower), choose(digits)];
  while (characters.length < length) characters.push(choose(all));
  for (let index = characters.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [characters[index], characters[other]] = [characters[other]!, characters[index]!];
  }
  return characters.join('');
}
