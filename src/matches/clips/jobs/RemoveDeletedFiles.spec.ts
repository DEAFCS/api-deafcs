import { RemoveDeletedFiles } from "./RemoveDeletedFiles";

const MATCH = "0f0e0d0c-0b0a-4908-8706-050403020100";

// MinIO that refuses removals until `recoversAfter` calls have failed.
const flakyS3 = (objects: string[], recoversAfter: number) => {
  const stored = new Set(objects);
  let failures = 0;
  const down = () => failures++ < recoversAfter;
  return {
    stored,
    remove: jest.fn(async (key: string) =>
      down() ? false : stored.delete(key),
    ),
    has: jest.fn(async (key: string) => stored.has(key)),
    removePrefix: jest.fn(async (prefix: string) => {
      if (down()) {
        throw new Error("minio unavailable");
      }
      for (const key of [...stored]) {
        if (key.startsWith(prefix)) {
          stored.delete(key);
        }
      }
      return 1;
    }),
  };
};

// The part of a BullMQ job the processor uses, run the way BullMQ retries it.
const job = (data: { keys: string[]; prefixes: string[] }, attempts = 10) => {
  const fake = {
    data,
    opts: { attempts },
    attemptsMade: 0,
    updateData: jest.fn(async (next: typeof data) => {
      fake.data = next;
    }),
  };
  return fake;
};

describe("RemoveDeletedFiles", () => {
  const files = {
    keys: ["clips/system/job-1.mp4", "clips/system/job-1.jpg"],
    prefixes: [`demos/${MATCH}/`],
  };
  const objects = [...files.keys, `demos/${MATCH}/map/1.dem`];

  it("removes everything and finishes", async () => {
    const s3 = flakyS3(objects, 0);
    const logger = { error: jest.fn() };
    const worker = new RemoveDeletedFiles(s3 as any, logger as any);

    await expect(worker.process(job(files) as any)).resolves.toBe(3);
    expect(s3.stored.size).toBe(0);
  });

  it("throws while MinIO fails so BullMQ retries, keeping only what is left", async () => {
    const s3 = flakyS3(objects, 1);
    const logger = { error: jest.fn() };
    const worker = new RemoveDeletedFiles(s3 as any, logger as any);
    const retried = job(files);

    await expect(worker.process(retried as any)).rejects.toThrow(
      "1 deleted file(s) still stored, will retry",
    );
    expect(retried.updateData).toHaveBeenCalledWith({
      keys: ["clips/system/job-1.mp4"],
      prefixes: [],
    });
    expect(logger.error).not.toHaveBeenCalled();

    // The retry after MinIO recovers removes what was left.
    retried.attemptsMade = 1;
    await expect(worker.process(retried as any)).resolves.toBe(1);
    expect(s3.stored.size).toBe(0);
  });

  it("logs every key it gives up on at the last attempt", async () => {
    const s3 = flakyS3(objects, Infinity);
    const logger = { error: jest.fn() };
    const worker = new RemoveDeletedFiles(s3 as any, logger as any);
    const last = job(files, 3);
    last.attemptsMade = 2;

    await expect(worker.process(last as any)).rejects.toThrow(
      "3 deleted file(s) still stored, will retry",
    );
    expect(logger.error).toHaveBeenCalledWith(
      `[remove-deleted-files] giving up, still stored: clips/system/job-1.mp4, clips/system/job-1.jpg, demos/${MATCH}/`,
    );
  });
});
