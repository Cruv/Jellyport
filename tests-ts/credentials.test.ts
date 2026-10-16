import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CREDENTIAL_MESSAGE_TEMPLATE,
  MAX_CREDENTIAL_MESSAGE_TEMPLATE_LENGTH,
  renderCredentialMessage,
  validateCredentialMessageTemplate,
} from '../server/credential-message.js';
import { discordCredentialContent, generatePassword } from '../server/credentials.js';
import { validateSettings } from '../server/settings.js';
import { DEFAULT_SETTINGS } from '../server/types.js';

describe('readable credential passwords', () => {
  it.each([12, 16, 64])(
    'uses the configured length %i without symbols or ambiguous characters',
    (length) => {
      const passwords = new Set(
        Array.from({ length: 100 }, () => generatePassword({ password_length: length })),
      );
      expect(passwords.size).toBe(100);
      for (const password of passwords) {
        expect(password).toHaveLength(length);
        expect(password).toMatch(/^[A-Za-z2-9]+$/);
        expect(password).not.toMatch(/[0Oo1IilL]/);
        expect(password).toMatch(/[A-Z]/);
        expect(password).toMatch(/[a-z]/);
        expect(password).toMatch(/[2-9]/);
      }
    },
  );

  it('can include the complete alphanumeric alphabet while still excluding symbols', () => {
    const passwords = Array.from({ length: 100 }, () =>
      generatePassword({ password_length: 64, password_exclude_ambiguous: false }),
    );
    expect(passwords.every((password) => /^[A-Za-z0-9]{64}$/.test(password))).toBe(true);
    expect(passwords.join('')).toMatch(/[0Oo1IilL]/);
  });

  it.each([0, 11, 65, 12.5, NaN, Infinity, null, '12', false])(
    'rejects invalid configured length %s',
    (length) => {
      expect(() => generatePassword({ password_length: length as number })).toThrow(
        'Password length must be a whole number between 12 and 64.',
      );
      expect(() => validateSettings({ ...DEFAULT_SETTINGS, password_length: length })).toThrow();
    },
  );

  it.each([0, 1, null, 'true', {}])('rejects invalid ambiguity policy %s', (value) => {
    expect(() => generatePassword({ password_exclude_ambiguous: value as boolean })).toThrow(
      'password_exclude_ambiguous must be a boolean.',
    );
    expect(() =>
      validateSettings({ ...DEFAULT_SETTINGS, password_exclude_ambiguous: value }),
    ).toThrow();
  });
});

describe('shared credential messages', () => {
  const values = {
    username: 'river',
    password: 'aBC23Def45GH',
    server_url: 'https://jellyfin.example.test',
  };

  it('provides the same default template and renders literal credentials in a single pass', () => {
    expect(DEFAULT_SETTINGS.credential_message_template).toBe(DEFAULT_CREDENTIAL_MESSAGE_TEMPLATE);
    expect(renderCredentialMessage(DEFAULT_CREDENTIAL_MESSAGE_TEMPLATE, values)).toBe(
      'Your Jellyfin account is ready.\n\n' +
        'Server: https://jellyfin.example.test\nUsername: river\nPassword: aBC23Def45GH\n\n' +
        'Keep these credentials private. You can change your password in Jellyfin.',
    );
    expect(
      renderCredentialMessage('{username}\n{password}\n{server_url}\n{username}', {
        ...values,
        username: '{password}',
      }),
    ).toBe('{password}\naBC23Def45GH\nhttps://jellyfin.example.test\n{password}');
  });

  it('accepts a multiline custom message and normal plaintext without evaluating expressions', () => {
    const template = 'Welcome aboard, {username}!\n{server_url}\nPassword: {password}\nEnjoy 🎬';
    expect(() =>
      validateSettings({ ...DEFAULT_SETTINGS, credential_message_template: template }),
    ).not.toThrow();
    expect(renderCredentialMessage(template, values)).toContain('Welcome aboard, river!');
    expect(renderCredentialMessage(template, values)).toContain('Enjoy 🎬');
    const pasted = template.replaceAll('\n', '\r\n');
    expect(() =>
      validateSettings({ ...DEFAULT_SETTINGS, credential_message_template: pasted }),
    ).not.toThrow();
    expect(renderCredentialMessage(pasted, values)).toContain('\r\n');
    expect(discordCredentialContent(renderCredentialMessage(pasted, values))).toContain('\r\n');
  });

  it.each([
    '',
    ' ',
    '{username} {password}',
    '{password} {server_url}',
    '{username} {server_url}',
    '{username} {password} {server_url} {email}',
    '{username} {password} {server_url} ${process.env.SECRET}',
    '{username} {password} {server_url} {{username}}',
    '{username} {password} {server_url} {',
    '{username} {password} {server_url}\r',
    '{username} {password} {server_url}\t',
    '{username} {password} {server_url}\u0000',
    '{username} {password} {server_url}\u202e',
    '{username} {password} {server_url}\ud800',
    `${'a'.repeat(MAX_CREDENTIAL_MESSAGE_TEMPLATE_LENGTH)}{username}{password}{server_url}`,
  ])('rejects malformed templates without echoing their content', (template) => {
    expect(() => validateCredentialMessageTemplate(template)).toThrow();
    expect(() =>
      validateSettings({ ...DEFAULT_SETTINGS, credential_message_template: template }),
    ).toThrow();
  });

  it('bounds expanded output even with repeated valid placeholders', () => {
    expect(() =>
      renderCredentialMessage(`{username}{password}${'{server_url}'.repeat(90)}`, values),
    ).toThrow('The account message is too long after inserting the credentials.');
    expect(() =>
      validateSettings({
        ...DEFAULT_SETTINGS,
        credential_message_template: `{username}{password}${'{server_url}'.repeat(70)}`,
      }),
    ).toThrow('The account message is too long after inserting the credentials.');
  });

  it('reserves space for Discord escaping and the longest supported new username before saving', () => {
    expect(() =>
      validateSettings({
        ...DEFAULT_SETTINGS,
        credential_message_template: `${'\\'.repeat(1000)}{username}{password}{server_url}`,
      }),
    ).toThrow('The account message is too long after formatting for Discord.');
    expect(() =>
      validateSettings({
        ...DEFAULT_SETTINGS,
        credential_message_template: '{username}{password}{server_url}',
        jellyfin_public_url: `https://jellyfin.example.test/${'x'.repeat(1900)}`,
      }),
    ).toThrow('The account message is too long after inserting the credentials.');
  });

  it.each([
    { username: '' },
    { username: 'river\nPassword: spoof' },
    { username: 'x'.repeat(257) },
    { password: '' },
    { password: 'x'.repeat(513) },
    { password: 'secret\u0000' },
    { server_url: '' },
    { server_url: 'x'.repeat(4097) },
    { server_url: 'https://example.test\u202e' },
  ])('rejects unsafe inserted values without exposing their content', (patch) => {
    expect(() =>
      renderCredentialMessage(DEFAULT_CREDENTIAL_MESSAGE_TEMPLATE, { ...values, ...patch }),
    ).toThrow('Credentials could not be formatted for delivery.');
  });
});
