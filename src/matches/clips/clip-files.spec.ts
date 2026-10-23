import { removeDeletedFiles } from "./clip-files";

const MATCH = "0f0e0d0c-0b0a-4908-8706-050403020100";

// A MinIO stand-in: removing a missing key answers false (as S3Service.remove
// does), `stuck` keys cannot be removed, `failingPrefixes` throw.
const fakeS3 = (
  objects: string[],
  options: { stuck?: string[]; failingPrefixes?: string[] } = {},
) => {
  const stored = new Set(objects);
  return {
    stored,
    remove: jest.fn(async (key: string) =>
      options.stuck?.includes(key) ? false : stored.delete(key),
    ),
    has: jest.fn(async (key: string) => stored.has(key)),
    removePrefix: jest.fn(async (prefix: string) => {
      if (options.failingPrefixes?.includes(prefix)) {
        throw new Error("minio unavailable");
      }
      let removed = 0;
      for (const key of [...stored]) {
        if (key.startsWith(prefix)) {
          stored.delete(key);
          removed++;
        }
      }
      return removed;
    }),
  };
};

describe("removeDeletedFiles", () => {
  it("removes exactly the clip keys and the match's demo folder", async () => {
    const s3 = fakeS3([
      "clips/system/job-1.mp4",
      "clips/system/job-1.jpg",
      "clips/system/job-10.mp4",
      `demos/${MATCH}/map/1.dem`,
      "demos/other-match/map/1.dem",
    ]);

    const left = await removeDeletedFiles(s3 as any, {
      keys: ["clips/system/job-1.mp4", "clips/system/job-1.jpg"],
      prefixes: [`demos/${MATCH}/`],
    });

    expect(left).toEqual({ keys: [], prefixes: [] });
    expect([...s3.stored]).toEqual([
      "clips/system/job-10.mp4",
      "demos/other-match/map/1.dem",
    ]);
  });

  it("counts a key that was already gone as removed", async () => {
    const s3 = fakeS3([]);

    await expect(
      removeDeletedFiles(s3 as any, {
        keys: ["clips/system/job-1.mp4"],
        prefixes: [],
      }),
    ).resolves.toEqual({ keys: [], prefixes: [] });
  });

  it("answers what MinIO could not remove", async () => {
    const s3 = fakeS3(["clips/system/job-1.mp4", "clips/system/job-1.jpg"], {
      stuck: ["clips/system/job-1.mp4"],
      failingPrefixes: [`demos/${MATCH}/`],
    });

    await expect(
      removeDeletedFiles(s3 as any, {
        keys: ["clips/system/job-1.mp4", "clips/system/job-1.jpg"],
        prefixes: [`demos/${MATCH}/`],
      }),
    ).resolves.toEqual({
      keys: ["clips/system/job-1.mp4"],
      prefixes: [`demos/${MATCH}/`],
    });
    expect(s3.stored.has("clips/system/job-1.jpg")).toBe(false);
  });

  it("never touches a key outside clips/ or a prefix other than a match's demos", async () => {
    const s3 = fakeS3(["avatars/1.png", "demos/a.dem"]);

    await removeDeletedFiles(s3 as any, {
      keys: ["avatars/1.png", ""],
      prefixes: ["demos/", "", "clips/", `demos/${MATCH}`],
    });

    expect(s3.remove).not.toHaveBeenCalled();
    expect(s3.removePrefix).not.toHaveBeenCalled();
    expect(s3.stored.size).toBe(2);
  });
});
