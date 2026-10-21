import { CacheService } from "./cache.service";

// A shared (Redis) cached computation that never lets visitors pile up on
// the expensive work:
//
// - fresh value cached       -> returned as is
// - stale value cached       -> returned at once; one caller (holding the
//                               lock) recomputes in the background
// - nothing cached (cold)    -> one caller computes; the others wait briefly
//                               for its result and otherwise get `null`
//                               ("temporarily unavailable"), never a second
//                               computation
//
// Built only on CacheService's get/put and its token-safe acquireLock /
// releaseLock, so it works the same across every API pod.

export type Cached<T> = {
  value: T;
  // ISO time the value was computed.
  generatedAt: string;
  // Epoch ms after which the value is stale (still served, refreshed).
  freshUntil: number;
};

export type StaleWhileRevalidateOptions = {
  // Seconds a value counts as fresh.
  freshSeconds: number;
  // Seconds a value is kept at all (fresh + stale window). Must be larger.
  keepSeconds: number;
  // Lock lifetime: longer than the slowest expected computation.
  lockSeconds: number;
  // On a cold cache, how long a caller waits for another caller's result.
  waitMs: number;
  pollMs?: number;
};

export type CachedResult<T> =
  | { status: "fresh" | "stale" | "computed"; value: T; generatedAt: string }
  | { status: "unavailable"; value: null; generatedAt: null };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function staleWhileRevalidate<T>(
  cache: Pick<CacheService, "get" | "put" | "acquireLock" | "releaseLock">,
  key: string,
  options: StaleWhileRevalidateOptions,
  compute: () => Promise<T>,
  onBackgroundError?: (error: unknown) => void,
): Promise<CachedResult<T>> {
  const lockKey = `lock:${key}`;

  const store = async (value: T): Promise<Cached<T>> => {
    const entry: Cached<T> = {
      value,
      generatedAt: new Date().toISOString(),
      freshUntil: Date.now() + options.freshSeconds * 1000,
    };
    await cache.put(key, entry as any, options.keepSeconds);
    return entry;
  };

  const refreshHoldingLock = async (token: string): Promise<Cached<T>> => {
    try {
      return await store(await compute());
    } finally {
      await cache.releaseLock(lockKey, token);
    }
  };

  const cached = (await cache.get(key)) as Cached<T> | undefined;
  if (cached && typeof cached.freshUntil === "number") {
    if (cached.freshUntil > Date.now()) {
      return { status: "fresh", value: cached.value, generatedAt: cached.generatedAt };
    }
    const token = await cache.acquireLock(lockKey, options.lockSeconds);
    if (token) {
      // Fire and forget: this caller still answers with the stale value.
      void refreshHoldingLock(token).catch((error) => onBackgroundError?.(error));
    }
    return { status: "stale", value: cached.value, generatedAt: cached.generatedAt };
  }

  const token = await cache.acquireLock(lockKey, options.lockSeconds);
  if (token) {
    const entry = await refreshHoldingLock(token);
    return { status: "computed", value: entry.value, generatedAt: entry.generatedAt };
  }

  // Someone else is computing: wait for their result instead of repeating it.
  const pollMs = options.pollMs ?? 250;
  for (let waited = 0; waited < options.waitMs; waited += pollMs) {
    await sleep(pollMs);
    const ready = (await cache.get(key)) as Cached<T> | undefined;
    if (ready && typeof ready.freshUntil === "number") {
      return { status: "fresh", value: ready.value, generatedAt: ready.generatedAt };
    }
  }
  return { status: "unavailable", value: null, generatedAt: null };
}
