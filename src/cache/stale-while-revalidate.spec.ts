import { staleWhileRevalidate } from "./stale-while-revalidate";

// In-memory stand-in with the same SET NX lock semantics as CacheService.
class FakeCache {
  public store = new Map<string, any>();
  public locks = new Map<string, string>();
  public puts = 0;
  async get(key: string) {
    const raw = this.store.get(key);
    return raw === undefined ? undefined : JSON.parse(raw);
  }
  async put(key: string, value: any) {
    this.puts++;
    this.store.set(key, JSON.stringify(value));
    return true;
  }
  async acquireLock(key: string) {
    if (this.locks.has(key)) return null;
    const token = `t${Math.random()}`;
    this.locks.set(key, token);
    return token;
  }
  async releaseLock(key: string, token: string) {
    if (this.locks.get(key) !== token) return false;
    this.locks.delete(key);
    return true;
  }
}

const OPTIONS = { freshSeconds: 300, keepSeconds: 900, lockSeconds: 60, waitMs: 1000, pollMs: 10 };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("staleWhileRevalidate", () => {
  let cache: FakeCache;
  beforeEach(() => {
    cache = new FakeCache();
  });

  it("cold cache: computes once, stores, and releases the lock", async () => {
    const compute = jest.fn(async () => ({ n: 1 }));
    const result = await staleWhileRevalidate(cache as any, "k", OPTIONS, compute);
    expect(result).toMatchObject({ status: "computed", value: { n: 1 } });
    expect(compute).toHaveBeenCalledTimes(1);
    expect(cache.locks.size).toBe(0);
    expect((await cache.get("k")).value).toEqual({ n: 1 });
  });

  it("fresh value: served without computing", async () => {
    await staleWhileRevalidate(cache as any, "k", OPTIONS, async () => 1);
    const compute = jest.fn(async () => 2);
    const result = await staleWhileRevalidate(cache as any, "k", OPTIONS, compute);
    expect(result).toMatchObject({ status: "fresh", value: 1 });
    expect(compute).not.toHaveBeenCalled();
  });

  it("stale value: served immediately, refreshed once in the background", async () => {
    await cache.put("k", { value: "old", generatedAt: "x", freshUntil: Date.now() - 1 });
    let release!: () => void;
    const compute = jest.fn(() => new Promise<string>((resolve) => (release = () => resolve("new"))));

    const first = await staleWhileRevalidate(cache as any, "k", OPTIONS, compute);
    const second = await staleWhileRevalidate(cache as any, "k", OPTIONS, compute);
    expect(first).toMatchObject({ status: "stale", value: "old" });
    expect(second).toMatchObject({ status: "stale", value: "old" });
    // The second caller found the lock taken: still one computation.
    expect(compute).toHaveBeenCalledTimes(1);

    release();
    await flush();
    await flush();
    expect((await cache.get("k")).value).toBe("new");
    expect(cache.locks.size).toBe(0);
  });

  it("concurrent cold callers: one computation, the others wait for it", async () => {
    let release!: () => void;
    const compute = jest.fn(() => new Promise<number>((resolve) => (release = () => resolve(42))));
    const calls = Array.from({ length: 5 }, () =>
      staleWhileRevalidate(cache as any, "k", OPTIONS, compute),
    );
    await flush();
    release();
    const results = await Promise.all(calls);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.value === 42)).toBe(true);
  });

  it("cold cache and the computation takes too long: others get 'unavailable', never a second run", async () => {
    const compute = jest.fn(() => new Promise<number>(() => {})); // never finishes
    void staleWhileRevalidate(cache as any, "k", OPTIONS, compute);
    await flush();
    const waiting = await staleWhileRevalidate(
      cache as any,
      "k",
      { ...OPTIONS, waitMs: 50 },
      compute,
    );
    expect(waiting).toEqual({ status: "unavailable", value: null, generatedAt: null });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("a failed computation releases the lock and rethrows (cold path)", async () => {
    await expect(
      staleWhileRevalidate(cache as any, "k", OPTIONS, async () => {
        throw new Error("db down");
      }),
    ).rejects.toThrow("db down");
    expect(cache.locks.size).toBe(0);
  });

  it("a failed background refresh keeps serving the stale value and reports the error", async () => {
    await cache.put("k", { value: "old", generatedAt: "x", freshUntil: Date.now() - 1 });
    const onError = jest.fn();
    const result = await staleWhileRevalidate(
      cache as any,
      "k",
      OPTIONS,
      async () => {
        throw new Error("boom");
      },
      onError,
    );
    await flush();
    await flush();
    expect(result).toMatchObject({ status: "stale", value: "old" });
    expect(onError).toHaveBeenCalled();
    expect(cache.locks.size).toBe(0);
    expect((await cache.get("k")).value).toBe("old");
  });
});
