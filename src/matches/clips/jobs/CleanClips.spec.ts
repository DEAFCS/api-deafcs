import { CleanClips } from "./CleanClips";

const GB = 1024 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;

type Clip = {
  id: string;
  size: number;
  file: string;
  thumbnail_url: string | null;
  created_at: string;
};

// Clips are stored under their render job id, not the clip id.
const clip = (
  id: string,
  sizeGB: number,
  daysAgo: number,
  thumbnail = true,
): Clip => ({
  id,
  size: sizeGB * GB,
  file: `clips/system/job-${id}.mp4`,
  thumbnail_url: thumbnail ? `clips/system/job-${id}.jpg` : null,
  created_at: new Date(Date.now() - daysAgo * DAY).toISOString(),
});

// A stand-in for Hasura and MinIO that answers like the real ones: retention
// filter, order (created_at, then id), limit and offset; deleted rows are gone
// from the next page. Keys in `stuck` cannot be removed.
const setup = (
  clips: Clip[],
  settings: { maxGB: number; retentionDays: number },
  stuck: string[] = [],
) => {
  const rows = [...clips];
  const objects = new Set(
    clips.flatMap((row) => [row.file, row.thumbnail_url].filter(Boolean)),
  );
  const pages: Array<{ offset: number; orderById: boolean }> = [];

  const query = jest.fn(async (q: any) => {
    if (q.settings) {
      return {
        settings: [
          {
            name: "clips_min_retention",
            value: String(settings.retentionDays),
          },
          { name: "clips_max_storage", value: String(settings.maxGB) },
        ],
      };
    }
    if (q.match_clips_aggregate) {
      return {
        match_clips_aggregate: {
          aggregate: {
            sum: { size: rows.reduce((total, row) => total + row.size, 0) },
          },
        },
      };
    }
    const args = q.match_clips.__args;
    if (args.where.size) {
      return { match_clips: rows.filter((row) => row.size === 0) };
    }
    const before = args.where.created_at._lt;
    const orderById = args.order_by.some((order: any) => order.id === "asc");
    const offset = args.offset ?? 0;
    pages.push({ offset, orderById });
    return {
      match_clips: rows
        .filter((row) => row.created_at < before)
        .sort(
          (a, b) =>
            a.created_at.localeCompare(b.created_at) ||
            a.id.localeCompare(b.id),
        )
        .slice(offset, offset + args.limit),
    };
  });

  const mutation = jest.fn(async (m: any) => {
    if (m.delete_match_clips_by_pk) {
      const index = rows.findIndex(
        (row) => row.id === m.delete_match_clips_by_pk.__args.id,
      );
      rows.splice(index, 1);
    }
    return {};
  });

  const s3 = {
    remove: jest.fn(async (key: string) => {
      if (stuck.includes(key)) {
        return false;
      }
      return objects.delete(key);
    }),
    has: jest.fn(async (key: string) => objects.has(key)),
    stat: jest.fn(),
  };

  const logger = { log: jest.fn(), warn: jest.fn() };
  const job = new CleanClips(
    s3 as any,
    logger as any,
    {
      query,
      mutation,
    } as any,
  );

  return { job, rows, objects, s3, logger, pages };
};

describe("CleanClips", () => {
  // The DEAFCS production settings: 100 GB, 30 days.
  const settings = { maxGB: 100, retentionDays: 30 };

  it("deletes nothing below the limit", async () => {
    const { job, s3, rows } = setup(
      [clip("a", 40, 60), clip("b", 21, 10)],
      settings,
    );

    await expect(job.process()).resolves.toBe(0);
    expect(s3.remove).not.toHaveBeenCalled();
    expect(rows).toHaveLength(2);
  });

  it("deletes the oldest clips past retention until under the limit, files first", async () => {
    const { job, rows, objects } = setup(
      [clip("old-1", 30, 50), clip("old-2", 30, 40), clip("recent", 60, 5)],
      settings,
    );

    await expect(job.process()).resolves.toBe(1);
    expect(rows.map((row) => row.id)).toEqual(["old-2", "recent"]);
    expect(objects.has("clips/system/job-old-1.mp4")).toBe(false);
    expect(objects.has("clips/system/job-old-1.jpg")).toBe(false);
    expect(objects.has("clips/system/job-old-2.mp4")).toBe(true);
  });

  it("never deletes a clip inside retention, even over the limit", async () => {
    const { job, rows, s3 } = setup(
      [clip("new-1", 80, 10), clip("new-2", 80, 1)],
      settings,
    );

    await expect(job.process()).resolves.toBe(0);
    expect(rows).toHaveLength(2);
    expect(s3.remove).not.toHaveBeenCalled();
  });

  it("removes a clip without a thumbnail", async () => {
    const { job, rows, objects } = setup(
      [clip("old", 10, 40, false), clip("recent", 95, 1)],
      settings,
    );

    await expect(job.process()).resolves.toBe(1);
    expect(rows.map((row) => row.id)).toEqual(["recent"]);
    expect(objects.has("clips/system/job-old.mp4")).toBe(false);
  });

  // Upstream deleted the row anyway, so the file stayed untracked.
  it("keeps the row of a clip whose file could not be removed and moves on", async () => {
    const { job, rows, objects, logger } = setup(
      [clip("stuck", 30, 50), clip("next", 30, 40), clip("recent", 60, 5)],
      settings,
      ["clips/system/job-stuck.mp4"],
    );

    await expect(job.process()).resolves.toBe(1);
    expect(rows.map((row) => row.id)).toEqual(["stuck", "recent"]);
    expect(objects.has("clips/system/job-stuck.mp4")).toBe(true);
    expect(objects.has("clips/system/job-next.mp4")).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "[clean-clips] kept clip stuck: its files could not be removed",
    );
  });

  // Without the offset the loop re-read the stuck clips forever.
  it("ends when every eligible clip is stuck", async () => {
    const clips = Array.from({ length: 25 }, (_, index) =>
      clip(`stuck-${String(index).padStart(2, "0")}`, 5, 40 + index),
    );
    const { job, rows, pages } = setup(
      clips,
      { maxGB: 10, retentionDays: 30 },
      clips.map((row) => row.file),
    );

    await expect(job.process()).resolves.toBe(0);
    expect(rows).toHaveLength(25);
    expect(pages.map((page) => page.offset)).toEqual([0, 10, 20, 25]);
    expect(pages.every((page) => page.orderById)).toBe(true);
  });

  it("counts a file that was already gone as removed", async () => {
    const { job, rows, objects } = setup(
      [clip("gone", 30, 50), clip("recent", 80, 5)],
      settings,
    );
    objects.delete("clips/system/job-gone.mp4");

    await expect(job.process()).resolves.toBe(1);
    expect(rows.map((row) => row.id)).toEqual(["recent"]);
  });
});
