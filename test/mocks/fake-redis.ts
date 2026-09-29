/**
 * Minimal in-memory Redis for matchmaking unit tests. Every command yields
 * to the event loop first (like a real round trip), so concurrent callers
 * interleave between commands; each command itself, including the Lua
 * scripts, runs atomically, exactly like Redis.
 */
export class FakeRedis {
  public strings = new Map<string, string>();
  public hashes = new Map<string, Map<string, string>>();
  public zsets = new Map<string, Map<string, number>>();
  public published: Array<{ channel: string; message: any }> = [];
  public evalCalls: string[] = [];

  private tick() {
    return new Promise((resolve) => setImmediate(resolve));
  }

  private hash(key: string) {
    let hash = this.hashes.get(key);
    if (!hash) {
      hash = new Map();
      this.hashes.set(key, hash);
    }
    return hash;
  }

  private zset(key: string) {
    let zset = this.zsets.get(key);
    if (!zset) {
      zset = new Map();
      this.zsets.set(key, zset);
    }
    return zset;
  }

  private existsSync(key: string) {
    return (
      this.strings.has(key) ||
      (this.hashes.get(key)?.size ?? 0) > 0 ||
      (this.zsets.get(key)?.size ?? 0) > 0
    );
  }

  async get(key: string) {
    await this.tick();
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: unknown, ...args: unknown[]) {
    await this.tick();
    if (args.includes("NX") && this.existsSync(key)) {
      return null;
    }
    this.strings.set(key, String(value));
    return "OK";
  }

  async del(...keys: string[]) {
    await this.tick();
    let removed = 0;
    for (const key of keys) {
      if (this.existsSync(key)) {
        removed++;
      }
      this.strings.delete(key);
      this.hashes.delete(key);
      this.zsets.delete(key);
    }
    return removed;
  }

  async exists(key: string) {
    await this.tick();
    return this.existsSync(key) ? 1 : 0;
  }

  async expire(key: string, seconds: number) {
    await this.tick();
    if (Number(seconds) <= 0) {
      return this.del(key);
    }
    return this.existsSync(key) ? 1 : 0;
  }

  async hset(key: string, ...args: any[]) {
    await this.tick();
    const hash = this.hash(key);
    if (args.length === 1 && typeof args[0] === "object") {
      for (const [field, value] of Object.entries(args[0])) {
        hash.set(field, String(value));
      }
      return 1;
    }
    for (let i = 0; i < args.length; i += 2) {
      hash.set(String(args[i]), String(args[i + 1]));
    }
    return 1;
  }

  async hget(key: string, field: string) {
    await this.tick();
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hgetall(key: string) {
    await this.tick();
    return Object.fromEntries(this.hashes.get(key) ?? new Map());
  }

  async hdel(key: string, ...fields: string[]) {
    await this.tick();
    const hash = this.hashes.get(key);
    for (const field of fields) {
      hash?.delete(field);
    }
    return 1;
  }

  async zadd(key: string, score: number, member: string) {
    await this.tick();
    this.zset(key).set(member, Number(score));
    return 1;
  }

  async zrem(key: string, member: string) {
    await this.tick();
    return this.zsets.get(key)?.delete(member) ? 1 : 0;
  }

  private sortedMembers(key: string) {
    return [...(this.zsets.get(key) ?? new Map()).entries()].sort(
      (a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : 1),
    );
  }

  async zrange(
    key: string,
    _start: number,
    _stop: number,
    withScores?: string,
  ) {
    await this.tick();
    const members = this.sortedMembers(key);
    return withScores
      ? members.flatMap(([member, score]) => [member, String(score)])
      : members.map(([member]) => member);
  }

  async zrank(key: string, member: string) {
    await this.tick();
    const index = this.sortedMembers(key).findIndex(([m]) => m === member);
    return index === -1 ? null : index;
  }

  async publish(channel: string, message: string) {
    await this.tick();
    this.published.push({ channel, message: JSON.parse(message) });
    return 1;
  }

  async eval(script: string, keyCount: number, ...rest: unknown[]) {
    await this.tick();
    this.evalCalls.push(script);
    const keys = rest.slice(0, keyCount).map(String);
    const argv = rest.slice(keyCount).map(String);

    // Captain Pick draft creation.
    if (script.includes("'EXISTS'")) {
      if (this.existsSync(keys[0])) {
        return 0;
      }
      this.hash(keys[0]).set("state", argv[0]).set("version", "1");
      return 1;
    }

    // Captain Pick compare-and-set.
    if (script.includes("'version') ~=")) {
      const hash = this.hashes.get(keys[0]);
      if (hash?.get("version") !== argv[0]) {
        return 0;
      }
      hash.set("state", argv[1]).set("version", String(Number(argv[0]) + 1));
      return 1;
    }

    // Delete-if-equal (reverse player keys).
    if (script.includes("'GET', KEYS[1]) == ARGV[1]")) {
      if (this.strings.get(keys[0]) === argv[0]) {
        this.strings.delete(keys[0]);
        return 1;
      }
      return 0;
    }

    // Matchmaking CLAIM_LOBBY_SCRIPT.
    if (script.includes("'ZREM'")) {
      if (this.existsSync(keys[0])) {
        return 0;
      }
      this.strings.set(keys[0], "1");
      for (const key of keys.slice(1)) {
        this.zsets.get(key)?.delete(argv[0]);
      }
      return 1;
    }

    throw new Error("FakeRedis: unknown script");
  }

  // Test helpers.
  messagesTo(steamId: string, event?: string) {
    return this.published
      .filter(({ channel }) => channel === "send-message-to-steam-id")
      .map(({ message }) => message)
      .filter(
        (message) =>
          message.steamId === steamId && (!event || message.event === event),
      );
  }
}

export class FakeQueue {
  public jobs = new Map<string, { name: string; data: any; opts: any }>();
  public added: Array<{ name: string; data: any; opts: any }> = [];

  async add(name: string, data: any, opts: any = {}) {
    await new Promise((resolve) => setImmediate(resolve));
    this.added.push({ name, data, opts });
    // BullMQ ignores a job whose id already exists.
    if (!this.jobs.has(opts.jobId)) {
      this.jobs.set(opts.jobId, { name, data, opts });
    }
    return { id: opts.jobId };
  }

  async remove(jobId: string) {
    this.jobs.delete(jobId);
    return 1;
  }

  byName(name: string) {
    return [...this.jobs.values()].filter((job) => job.name === name);
  }
}
