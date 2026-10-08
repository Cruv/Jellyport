import { BlockList, isIP } from 'node:net';

const privateAddresses = new BlockList();
privateAddresses.addSubnet('127.0.0.0', 8);
privateAddresses.addSubnet('10.0.0.0', 8);
privateAddresses.addSubnet('172.16.0.0', 12);
privateAddresses.addSubnet('192.168.0.0', 16);
privateAddresses.addAddress('::1', 'ipv6');
privateAddresses.addSubnet('fc00::', 7, 'ipv6');

export function privateAddress(address: string): boolean {
  const value = address.replace(/^\[|\]$/g, '');
  const family = isIP(value);
  return family !== 0 && privateAddresses.check(value, family === 6 ? 'ipv6' : 'ipv4');
}

function hostName(authority: string): string {
  if (!authority || authority.length > 320 || /[\s\\/@?#,]/.test(authority))
    throw new Error('Invalid host.');
  const url = new URL(`http://${authority}`);
  if (url.username || url.password || !url.hostname) throw new Error('Invalid host.');
  const host = url.hostname
    .toLowerCase()
    .replace(/\.$/, '')
    .replace(/^\[|\]$/g, '');
  if (
    !isIP(host) &&
    (!/^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/.test(host) ||
      host.length > 253 ||
      host.split('.').some((label) => label.length > 63))
  )
    throw new Error('Invalid host.');
  return host;
}

function localName(host: string): boolean {
  return (
    (!host.includes('.') && !host.includes(':')) ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.home.arpa')
  );
}

/** Initial pairing requires a local address even when a public proxy hostname is allowed. */
export function localSetupHost(authority: string): boolean {
  const host = hostName(authority);
  return isIP(host) ? privateAddress(host) : localName(host);
}

export function hostPolicy(configured: string[]): (authority: string) => boolean {
  if (configured.length > 128) throw new Error('Too many JELLYPORT_ALLOWED_HOSTS entries.');
  const allowed = new Set(
    configured.map((value) => {
      const host = hostName(value);
      // Configuration names a host, without a scheme, path, port, or wildcard.
      if (
        value
          .toLowerCase()
          .replace(/\.$/, '')
          .replace(/^\[|\]$/g, '') !== host ||
        /[*]/.test(value)
      )
        throw new Error('JELLYPORT_ALLOWED_HOSTS must contain comma-separated hostnames.');
      return host;
    }),
  );
  return (authority: string) => {
    try {
      const host = hostName(authority);
      return !!isIP(host) || localName(host) || allowed.has(host);
    } catch {
      return false;
    }
  };
}

export function sameOrigin(authority: string, origin: string): boolean {
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin) return false;
    // Parse with the supplied scheme so the default port is normalized consistently.
    return url.host === new URL(`${url.protocol}//${authority}`).host;
  } catch {
    return false;
  }
}

/** Bounded per-address counters; pruning happens at most once a minute, not on every request. */
export class WindowLimiter {
  private readonly entries = new Map<string, number[]>();
  private nextPrune = 0;
  constructor(
    private readonly limit: number,
    private readonly windowMs = 600_000,
  ) {}

  allow(address: string): boolean {
    const now = Date.now();
    if (now >= this.nextPrune) {
      for (const [key, times] of this.entries)
        if (times[times.length - 1]! <= now - this.windowMs) this.entries.delete(key);
      this.nextPrune = now + 60_000;
    }
    const recent = (this.entries.get(address) ?? []).filter((time) => time > now - this.windowMs);
    if (recent.length >= this.limit) return false;
    if (!this.entries.has(address) && this.entries.size >= 10_000)
      this.entries.delete(this.entries.keys().next().value!);
    recent.push(now);
    this.entries.set(address, recent);
    return true;
  }

  delete(address: string): void {
    this.entries.delete(address);
  }
  clear(): void {
    this.entries.clear();
  }
}
