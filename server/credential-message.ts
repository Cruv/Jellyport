/** Shared plain-text templates. This module is also imported by the browser preview. */
export const DEFAULT_CREDENTIAL_MESSAGE_TEMPLATE =
  'Your Jellyfin account is ready.\n\n' +
  'Server: {server_url}\nUsername: {username}\nPassword: {password}\n\n' +
  'Keep these credentials private. You can change your password in Jellyfin.';

export const MAX_CREDENTIAL_MESSAGE_TEMPLATE_LENGTH = 1200;
export const MAX_CREDENTIAL_MESSAGE_LENGTH = 2000;
export const CREDENTIAL_MESSAGE_PLACEHOLDERS = ['username', 'password', 'server_url'] as const;
export type CredentialMessagePlaceholder = (typeof CREDENTIAL_MESSAGE_PLACEHOLDERS)[number];
export interface CredentialMessageValues {
  username: string;
  password: string;
  server_url: string;
}

const placeholder = /\{([^{}]*)\}/g;
const forbiddenTemplateControl = /[\p{C}]/u;

export function validateCredentialMessageTemplate(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > MAX_CREDENTIAL_MESSAGE_TEMPLATE_LENGTH ||
    forbiddenTemplateControl.test(value.replaceAll(/\r?\n/g, ''))
  )
    throw new Error(
      'The account message must be plain text of at most 1200 characters; only line breaks are allowed as control characters.',
    );
  const found = new Set<string>();
  const remainder = value.replace(placeholder, (_match, key: string) => {
    if (!CREDENTIAL_MESSAGE_PLACEHOLDERS.some((allowed) => allowed === key))
      throw new Error('The account message supports only {username}, {password} and {server_url}.');
    found.add(key);
    return '';
  });
  if (/[{}]/.test(remainder))
    throw new Error('The account message supports only {username}, {password} and {server_url}.');
  if (CREDENTIAL_MESSAGE_PLACEHOLDERS.some((key) => !found.has(key)))
    throw new Error('The account message must include {username}, {password} and {server_url}.');
}

/** Substitution is a single pass: credential contents can never become template expressions. */
export function renderCredentialMessage(template: string, values: CredentialMessageValues): string {
  validateCredentialMessageTemplate(template);
  if (
    typeof values.username !== 'string' ||
    !values.username ||
    values.username.length > 256 ||
    /\p{C}/u.test(values.username) ||
    typeof values.password !== 'string' ||
    !values.password ||
    values.password.length > 512 ||
    /\p{C}/u.test(values.password) ||
    typeof values.server_url !== 'string' ||
    !values.server_url ||
    values.server_url.length > 4096 ||
    /\p{C}/u.test(values.server_url)
  )
    throw new Error('Credentials could not be formatted for delivery.');
  const pieces: string[] = [];
  let previous = 0;
  for (const match of template.matchAll(placeholder)) {
    const literal = template.slice(previous, match.index);
    pieces.push(literal);
    const key = match[1] as CredentialMessagePlaceholder;
    pieces.push(values[key]);
    previous = match.index + match[0].length;
  }
  const tail = template.slice(previous);
  pieces.push(tail);
  const message = pieces.join('');
  if (message.length > MAX_CREDENTIAL_MESSAGE_LENGTH)
    throw new Error('The account message is too long after inserting the credentials.');
  return message;
}
