/**
 * @file services/api-gateway/src/rate-limiter.ts
 * Sliding Window In-Memory Rate Limiter (OWASP A07 & A04)
 */

export class RateLimiter {
  private requests = new Map<string, number[]>();

  isAllowed(key: string, maxRequests: number, windowMs: number): { allowed: boolean; remaining: number } {
    const now = Date.now();
    const timestamps = this.requests.get(key) || [];
    
    // Filter timestamps within current sliding window
    const validTimestamps = timestamps.filter((t) => now - t < windowMs);

    if (validTimestamps.length >= maxRequests) {
      this.requests.set(key, validTimestamps);
      return { allowed: false, remaining: 0 };
    }

    validTimestamps.push(now);
    this.requests.set(key, validTimestamps);
    return { allowed: true, remaining: maxRequests - validTimestamps.length };
  }
}

