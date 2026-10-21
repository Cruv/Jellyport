/** Versioned, identity-only messages. No billing decision can be inferred from one. */
export function parseMee6Identity(content: unknown): string | null {
  if (typeof content !== 'string' || content.length > 100 || /[\r\n]/.test(content)) return null;
  const match = /^JELLYPORT_IDENTITY_V1 discord=([1-9][0-9]{0,19})$/.exec(content);
  if (!match || BigInt(match[1]!) >= 2n ** 64n) return null;
  return match[1]!;
}
