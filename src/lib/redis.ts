import Redis from "ioredis";

export function createRedisConnection(url: string = process.env.REDIS_URL || "redis://localhost:6379"): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    tls: url.startsWith("rediss://") ? {} : undefined,
  });
}
