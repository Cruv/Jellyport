import { describe, expect, it } from 'vitest';
import { parseMee6Identity } from '../server/mee6-identity.js';

describe('versioned MEE6 identity hints', () => {
  it('accepts one exact durable Discord ID without inventing a billing relationship', () => {
    expect(parseMee6Identity('JELLYPORT_IDENTITY_V1 discord=123456789012345678')).toBe(
      '123456789012345678',
    );
  });
  it.each([
    'JELLYPORT_IDENTITY_V1 discord={user.id}',
    'JELLYPORT_IDENTITY_V1 discord=0',
    'JELLYPORT_IDENTITY_V1 discord=18446744073709551616',
    'JELLYPORT_IDENTITY_V1 discord=123\n',
    'JELLYPORT_IDENTITY_V1 discord=123 customer=cus_claimed',
    'JELLYPORT_IDENTITY_V1 discord=@nickname',
    'JELLYPORT_IDENTITY_V2 discord=123',
  ])('rejects unresolved variables, aliases, overflow and extra instructions: %s', (message) => {
    expect(parseMee6Identity(message)).toBeNull();
  });
});
