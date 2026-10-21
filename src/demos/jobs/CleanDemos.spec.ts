import { CleanDemos } from "./CleanDemos";

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

type Demo = {
  id: string;
  size: number;
  playback_size: number | null;
  file: string;
  ended_at: string;
};

// A stand-in for Hasura that answers the three queries CleanDemos makes the way
// the database would: retention filter, order, limit and offset. Rows that tie
// on ended_at come back in a scrambled order unless the query breaks the tie by
// id, as Postgres gives no order for ties.
const fakeHasura = (
  demos: Demo[],
  settings: { maxGB: number; retentionDays: number },
  options: { slow?: boolean } = {},
) => {
  const pages: Array<{ offset: number; limit: number; orderById: boolean }> =
    [];
  let scramble = 0;

  const query = jest.fn(async (q: any) => {
    if (options.slow) {
      // Real queries are network I/O: let timers run between them.
      await new Promise((resolve) => setImmediate(resolve));
    }

    if (q.settings) {
      return {
        settings: [
          { name: "s3_min_retention", value: String(settings.retentionDays) },
          { name: "s3_max_storage", value: String(settings.maxGB) },
        ],
      };
    }

    if (q.match_map_demos_aggregate) {
      return {
        match_map_demos_aggregate: {
          aggregate: {
            sum: {
              size: demos.reduce((total, demo) => total + demo.size, 0),
              playback_size: demos.reduce(
                (total, demo) => total + (demo.playback_size ?? 0),
                0,
              ),
            },
          },
        },
      };
    }

    const args = q.match_map_demos.__args;
    const before = args.where.match.ended_at._lt;
    const orderById = args.order_by.some((order: any) => order.id === "asc");
    const offset = args.offset ?? 0;
    pages.push({ offset, limit: args.limit, orderById });

    scramble++;
    const sorted = demos
      .filter((demo) => demo.ended_at < before)
      .map((demo, index) => ({
        demo,
        tie: orderById
          ? demo.id
          : String((index * 7919 + scramble * 104729) % 1000003).padStart(
              7,
              "0",
            ),
      }))
      .sort(
        (a, b) =>
          a.demo.ended_at.localeCompare(b.demo.ended_at) ||
          a.tie.localeCompare(b.tie),
      )
      .map(({ demo }) => demo);

    return {
      match_map_demos: sorted
        .slice(offset, offset + args.limit)
        .map(({ id, size, playback_size, file }) => ({
          id,
          size,
          playback_size,
          file,
        })),
    };
  });

  return { query, pages };
};

const demo = (
  id: string,
  size: number,
  daysAgo: number,
  playback_size: number | null = null,
): Demo => ({
  id,
  size,
  playback_size,
  file: `demos/${id}.dem`,
  ended_at: new Date(Date.now() - daysAgo * DAY).toISOString(),
});

const run = async (
  demos: Demo[],
  settings: { maxGB: number; retentionDays: number },
  options: { slow?: boolean } = {},
) => {
  const hasura = fakeHasura(demos, settings, options);
  const demoMetadata = { deleteDemo: jest.fn().mockResolvedValue(undefined) };
  const logger = { log: jest.fn(), warn: jest.fn() };
  const job = new CleanDemos(
    demoMetadata as any,
    logger as any,
    { query: hasura.query } as any,
  );
  const find = jest.spyOn(job as any, "findDemosToDelete");
  const marked = await job.process();
  const list = find.mock.results.length
    ? ((await find.mock.results[0].value) as Array<{ id: string }>)
    : [];
  return { marked, hasura, demoMetadata, logger, ids: list.map((d) => d.id) };
};

describe("CleanDemos", () => {
  // 30 days of retention, the DEAFCS production setting.
  const settings = { maxGB: 100, retentionDays: 30 };

  it("does nothing below the storage limit", async () => {
    const { marked, hasura, demoMetadata } = await run(
      [demo("a", 50 * GB, 60), demo("b", 49 * GB, 40)],
      settings,
    );

    expect(marked).toBe(0);
    expect(hasura.pages).toHaveLength(0);
    expect(demoMetadata.deleteDemo).not.toHaveBeenCalled();
  });

  it("does nothing at exactly the storage limit", async () => {
    const { marked, hasura, demoMetadata } = await run(
      [demo("a", 60 * GB, 60), demo("b", 30 * GB, 40, 10 * GB)],
      settings,
    );

    expect(marked).toBe(0);
    expect(hasura.pages).toHaveLength(0);
    expect(demoMetadata.deleteDemo).not.toHaveBeenCalled();
  });

  it("counts playback blobs toward the limit", async () => {
    const { marked } = await run(
      [demo("a", 60 * GB, 60), demo("b", 30 * GB, 40, 11 * GB)],
      settings,
    );

    expect(marked).toBe(1);
  });

  it("marks the oldest demos past retention until enough is freed, and deletes the oldest", async () => {
    const { marked, demoMetadata, logger } = await run(
      [
        demo("newest", 40 * GB, 1),
        demo("oldest", 3 * GB, 90),
        demo("second", 4 * GB, 80),
        demo("third", 5 * GB, 70),
        demo("fourth", 50 * GB, 60),
      ],
      settings, // 102 GB stored: 2 GB over
    );

    // 3 GB from the oldest is enough.
    expect(marked).toBe(1);
    expect(demoMetadata.deleteDemo).toHaveBeenCalledTimes(1);
    expect(demoMetadata.deleteDemo).toHaveBeenCalledWith("oldest");
    expect(logger.log).toHaveBeenCalledWith(
      "Marked 1 demos for deletion, freeing up 3.00 GB",
    );
  });

  it("keeps marking across pages until enough is freed", async () => {
    // 25 old demos of 1 GB each and a 90 GB recent one: 115 GB, 15 over.
    const demos = [
      demo("recent", 90 * GB, 1),
      ...Array.from({ length: 25 }, (_, i) =>
        demo(`old-${String(i).padStart(2, "0")}`, GB, 100 - i),
      ),
    ];
    const { marked, hasura, demoMetadata } = await run(demos, settings);

    expect(marked).toBe(15);
    expect(hasura.pages.map((page) => page.offset)).toEqual([0, 10]);
    // Only the first marked demo is deleted per run, as upstream does.
    expect(demoMetadata.deleteDemo).toHaveBeenCalledTimes(1);
    expect(demoMetadata.deleteDemo).toHaveBeenCalledWith("old-00");
  });

  it("never touches a demo inside the retention window", async () => {
    // 130 GB stored, but only 2 GB is past 30 days.
    const { marked, demoMetadata } = await run(
      [
        demo("old-1", GB, 45),
        demo("old-2", GB, 31),
        demo("recent-1", 64 * GB, 29),
        demo("recent-2", 64 * GB, 2),
      ],
      settings,
    );

    expect(marked).toBe(2);
    expect(demoMetadata.deleteDemo).toHaveBeenCalledTimes(1);
    expect(demoMetadata.deleteDemo).toHaveBeenCalledWith("old-1");
    expect(demoMetadata.deleteDemo).not.toHaveBeenCalledWith("recent-1");
    expect(demoMetadata.deleteDemo).not.toHaveBeenCalledWith("recent-2");
  });

  it("stops when no demo past retention is left", async () => {
    const { marked, hasura, demoMetadata } = await run(
      [demo("recent", 150 * GB, 2)],
      settings,
    );

    expect(marked).toBe(0);
    expect(hasura.pages).toHaveLength(1);
    expect(demoMetadata.deleteDemo).not.toHaveBeenCalled();
  });

  it("pages ties on ended_at by id, so no demo is marked twice or skipped", async () => {
    // 35 old demos that all ended at the same moment, 3 GB each: 105 GB + a
    // 10 GB recent one = 115 GB, 15 over -> 5 demos.
    const sameEnd = new Date(Date.now() - 60 * DAY).toISOString();
    const demos = [
      demo("recent", 10 * GB, 1),
      ...Array.from({ length: 35 }, (_, i) => ({
        ...demo(`tie-${String(i).padStart(2, "0")}`, 3 * GB, 60),
        ended_at: sameEnd,
      })),
    ];
    const { marked, hasura, demoMetadata } = await run(demos, settings);

    expect(marked).toBe(5);
    expect(hasura.pages.every((page) => page.orderById)).toBe(true);
    expect(demoMetadata.deleteDemo).toHaveBeenCalledWith("tie-00");

    // Enough to need several pages: every tied demo exactly once, in id order.
    const many = await run(demos, { maxGB: 10, retentionDays: 30 });
    const ids = many.ids;
    expect(many.marked).toBe(35);
    expect(new Set(ids).size).toBe(35);
    expect(ids).toEqual([...ids].sort());
    expect(many.hasura.pages.map((page) => page.offset)).toEqual([
      0, 10, 20, 30,
    ]);
  });

  // Production on 2026-10-21: 121 GB stored against 100, the oldest demo
  // 339 kB. The old code queried the same first page about 64,000 times and
  // built a list of one demo repeated, blocking the API for minutes.
  it("frees a large excess with one query per page and distinct demos", async () => {
    const demos = [
      demo("tiny-oldest", 339 * 1024, 120),
      ...Array.from({ length: 180 }, (_, i) =>
        demo(`old-${String(i).padStart(3, "0")}`, 123 * MB, 100 - i / 10),
      ),
      demo("recent", 100 * GB, 1),
    ];
    const { marked, hasura, demoMetadata, ids } = await run(demos, settings);

    expect(new Set(ids).size).toBe(marked);
    expect(marked).toBeLessThanOrEqual(181);
    expect(hasura.pages.length).toBe(Math.ceil(marked / 10));
    expect(demoMetadata.deleteDemo).toHaveBeenCalledTimes(1);
    expect(demoMetadata.deleteDemo).toHaveBeenCalledWith("tiny-oldest");
  });

  it("handles tens of thousands of demos without holding the event loop", async () => {
    // 20,000 old demos of 10 MB (about 195 GB) and limit 1 GB: nearly all of
    // them are needed, 2,000 pages.
    const demos = Array.from({ length: 20_000 }, (_, i) =>
      demo(`d-${String(i).padStart(5, "0")}`, 10 * MB, 400 - i / 100),
    );

    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const started = Date.now();
    const { marked, hasura, ids } = await run(
      demos,
      { maxGB: 1, retentionDays: 30 },
      { slow: true },
    );
    clearInterval(timer);

    expect(marked).toBe(20_000 - 102);
    expect(new Set(ids).size).toBe(marked);
    expect(hasura.pages.length).toBe(Math.ceil(marked / 10));
    // Timers kept running between the queries.
    expect(ticks).toBeGreaterThan(0);
    expect(Date.now() - started).toBeLessThan(30_000);
  }, 60_000);
});
