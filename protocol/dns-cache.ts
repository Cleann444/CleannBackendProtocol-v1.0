import dns from 'dns/promises';

export class DNSPreResolver {
  private cache = new Map<string, string[]>();
  
  async preResolve(hostnames: string[]) {
    const unique = [...new Set(hostnames)];
    await Promise.allSettled(unique.map(async (host) => {
      try {
        const addresses = await dns.resolve(host);
        this.cache.set(host, addresses);
      } catch(e) { }
    }));
  }
  
  getAddresses(host: string): string[] | null {
    return this.cache.get(host) || null;
  }
}
