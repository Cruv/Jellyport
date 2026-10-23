import { describe, expect, it } from 'vitest';
import {
  parseConfiguredSubscriptionMessage,
  validateSubscriptionMessagePatterns,
  type SubscriptionMessagePattern,
} from '../server/subscription-messages.js';
import { parseSubscriptionMessage } from '../server/bot.js';

const patterns: SubscriptionMessagePattern[] = [
  { action: 'subscribe', template: 'Joined: {user} / {plan}' },
  { action: 'cancel', template: '{user} canceled access.' },
  { action: 'expire', template: 'Expired: {user}' },
];
describe('literal trusted subscription formats', () => {
  it('recognizes mentions, usernames, plans and all actions without requiring a particular bot product', () => {
    expect(parseSubscriptionMessage('JOINED:  <@123456789> / Example Tier', patterns)).toEqual({
      action: 'subscribe',
      discord_user_id: '123456789',
      username: null,
      detail: 'Example Tier',
    });
    expect(parseSubscriptionMessage('person.actual canceled access.', patterns)).toMatchObject({
      action: 'cancel',
      username: 'person.actual',
    });
    expect(parseSubscriptionMessage('Expired: @person.actual', patterns)).toMatchObject({
      action: 'expire',
      username: 'person.actual',
    });
  });
  it('keeps legacy MEE6 formats when custom formats are empty or omitted', () => {
    const content = 'Good news captain! <@123456789> just subscribed to Example Plan!';
    expect(parseSubscriptionMessage(content, [])).toEqual(parseSubscriptionMessage(content));
    expect(parseSubscriptionMessage(content, patterns)).toBeNull();
  });
  it('escapes all regex-looking literals rather than treating them as executable matching patterns', () => {
    const literal: SubscriptionMessagePattern[] = [
      { action: 'subscribe', template: '[billing](a+)+: {user} + {plan}?' },
    ];
    expect(
      parseConfiguredSubscriptionMessage('[billing](a+)+: person + Example?', literal),
    ).toEqual({ action: 'subscribe', user: 'person', plan: 'Example' });
    expect(
      parseConfiguredSubscriptionMessage('billingaaaa: person + Example?', literal),
    ).toBeNull();
  });
  it('rejects overlapping matches instead of guessing their action', () => {
    expect(
      parseConfiguredSubscriptionMessage('Expired: person', [
        { action: 'expire', template: 'Expired: {user}' },
        { action: 'cancel', template: '{plan}: {user}' },
      ]),
    ).toBeNull();
  });
  it.each([
    null,
    {},
    Array.from({ length: 13 }, () => patterns[0]),
    [{ action: 'delete', template: '{user}' }],
    [{ action: 'subscribe', template: '{user}' }],
    [{ action: 'subscribe', template: '{user}{plan}' }],
    [{ action: 'cancel', template: '{user} {user}' }],
    [{ action: 'cancel', template: '{password}' }],
    [{ action: 'expire', template: 'x'.repeat(301) }],
    [{ action: 'expire', template: '{user}\n' }],
    [{ action: 'expire', template: '{user}', regex: true }],
    [
      { action: 'cancel', template: '  {user} canceled.' },
      { action: 'expire', template: '{user} CANCELED.' },
    ],
  ])('rejects malformed or oversized settings (%j)', (value) => {
    expect(() => validateSubscriptionMessagePatterns(value)).toThrow();
  });
  it.each([
    'Joined: <@0> / Tier',
    'Joined: <@18446744073709551616> / Tier',
    'Joined: user / Tier\nextra',
    'x'.repeat(501),
  ])('does not parse unsafe or oversized announcements (%s)', (content) => {
    expect(parseSubscriptionMessage(content, patterns)).toBeNull();
  });
});
