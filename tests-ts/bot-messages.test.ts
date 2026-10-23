import { describe, expect, it } from 'vitest';
import {
  BOT_MESSAGE_CATALOG,
  renderBotMessage,
  renderConfiguredBotMessage,
  validateBotMessageTemplates,
  type BotMessageTemplateId,
} from '../server/bot-messages.js';

describe('bounded bot message templates', () => {
  it.each(Object.keys(BOT_MESSAGE_CATALOG) as BotMessageTemplateId[])(
    'renders the %s default and allows a custom literal prefix',
    (id) => {
      const spec = BOT_MESSAGE_CATALOG[id];
      const original = renderBotMessage(id, undefined, spec.example);
      expect(original).toBeTruthy();
      const configured = { [id]: `Community notice\n${spec.template}` };
      expect(() => validateBotMessageTemplates(configured)).not.toThrow();
      expect(renderBotMessage(id, configured, spec.example)).toBe(`Community notice\n${original}`);
    },
  );
  it.each([
    null,
    [],
    { unknown: 'hello' },
    { job_status: '{password}' },
    { admin_digest: '{server_url}' },
    { job_status: 'Missing required fields' },
    { admin_test: 'x'.repeat(1201) },
    { admin_test: 'invalid\u0000' },
    { admin_test: '{{username}}' },
    { admin_test: '{username.toString()}' },
    { admin_test: 'private\u202e' },
  ])('rejects invalid configuration without evaluating it (%j)', (value) => {
    expect(() => validateBotMessageTemplates(value)).toThrow();
  });
  it('keeps substituted content literal and never interprets placeholders inside values', () => {
    expect(
      renderBotMessage(
        'command_error',
        { command_error: 'Note: {message}' },
        { message: '{password} $& ${process.env.SECRET}' },
      ),
    ).toBe('Note: {password} $& ${process.env.SECRET}');
  });
  it('bounds rendered content and rejects invalid runtime controls', () => {
    expect(() =>
      renderBotMessage(
        'admin_digest',
        { admin_digest: '{summary}{summary}' },
        { summary: 'x'.repeat(1001), server_url: '' },
      ),
    ).toThrow('too long');
    expect(() => renderBotMessage('command_error', undefined, { message: 'bad\r' })).toThrow(
      'could not be formatted',
    );
  });
  it('keeps a factual runtime response when an override expands beyond the preview length', () => {
    const value = 'A safe error explanation. '.repeat(12);
    expect(
      renderConfiguredBotMessage(
        'command_error',
        { command_error: '{message}'.repeat(20) },
        { message: value },
      ),
    ).toBe(value);
  });
  it('permits an empty override set and multiline summaries without credentials being a supported token', () => {
    expect(() => validateBotMessageTemplates({})).not.toThrow();
    expect(
      renderBotMessage('admin_digest', undefined, { summary: 'First\nSecond', server_url: '' }),
    ).toBe('First\nSecond');
    for (const spec of Object.values(BOT_MESSAGE_CATALOG))
      expect(spec.placeholders).not.toContain('password');
  });
});
