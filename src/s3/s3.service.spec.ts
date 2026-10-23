import { S3Service } from "./s3.service";

// DeleteObjects answers 200 and lists the keys it refused as <Error> entries;
// minio's removeObjects resolves with those entries instead of throwing.
describe("S3Service multi-delete errors", () => {
  let logger: { warn: jest.Mock; error: jest.Mock };
  let client: { listObjects: jest.Mock; removeObjects: jest.Mock };
  let s3: S3Service;

  const refused = (Key: string) => ({
    Code: "AccessDenied",
    Message: "Access Denied.",
    Key,
  });

  const listing = (names: string[]) =>
    (async function* () {
      for (const name of names) {
        yield { name, versionId: "null" };
      }
    })();

  beforeEach(() => {
    logger = { warn: jest.fn(), error: jest.fn() };
    client = { listObjects: jest.fn(), removeObjects: jest.fn() };
    // The constructor builds real minio clients; only the bucket, the logger
    // and the client matter here.
    s3 = Object.assign(Object.create(S3Service.prototype), {
      logger,
      client,
      bucket: "5stack",
    });
  });

  describe("removePrefixStrictly", () => {
    it("removes every listed object and answers how many", async () => {
      client.listObjects.mockReturnValue(
        listing(["demos/m/1.dem", "demos/m/playback/p.json.gz"]),
      );
      client.removeObjects.mockResolvedValue([]);

      await expect(s3.removePrefixStrictly("demos/m/")).resolves.toBe(2);
      expect(client.removeObjects).toHaveBeenCalledWith("5stack", [
        { name: "demos/m/1.dem" },
        { name: "demos/m/playback/p.json.gz" },
      ]);
    });

    it("throws when the store refuses a key, so the caller keeps its record", async () => {
      client.listObjects.mockReturnValue(
        listing(["demos/m/1.dem", "demos/m/2.dem"]),
      );
      client.removeObjects.mockResolvedValue([refused("demos/m/2.dem")]);

      await expect(s3.removePrefixStrictly("demos/m/")).rejects.toThrow(
        "unable to remove 1 object(s) under demos/m/: AccessDenied Access Denied.",
      );
    });

    it("also reads an entry shaped as minio declares it ({ Error })", async () => {
      client.listObjects.mockReturnValue(listing(["demos/m/1.dem"]));
      client.removeObjects.mockResolvedValue([
        { Error: refused("demos/m/1.dem") },
      ]);

      await expect(s3.removePrefixStrictly("demos/m/")).rejects.toThrow(
        /unable to remove 1 object\(s\) under demos\/m\//,
      );
    });

    it("throws when the request itself fails", async () => {
      client.listObjects.mockReturnValue(listing(["demos/m/1.dem"]));
      client.removeObjects.mockRejectedValue(new Error("connect ECONNREFUSED"));

      await expect(s3.removePrefixStrictly("demos/m/")).rejects.toThrow(
        "connect ECONNREFUSED",
      );
    });
  });

  describe("removePrefix", () => {
    it("logs refused keys instead of throwing and does not count them", async () => {
      client.listObjects.mockReturnValue(
        listing(["utility/l/1.mp4", "utility/l/2.mp4"]),
      );
      client.removeObjects.mockResolvedValue([refused("utility/l/2.mp4")]);

      await expect(s3.removePrefix("utility/l/")).resolves.toBe(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "unable to remove 1 object(s) under utility/l/: AccessDenied Access Denied.",
      );
    });
  });

  describe("removeKeys", () => {
    it("answers only the keys that are gone and logs each refused one", async () => {
      client.removeObjects.mockResolvedValue([refused("clips/a.mp4")]);

      await expect(
        s3.removeKeys(["clips/a.mp4", "clips/b.mp4", "clips/c.jpg"]),
      ).resolves.toEqual(["clips/b.mp4", "clips/c.jpg"]);
      expect(logger.error).toHaveBeenCalledWith(
        "unable to remove clips/a.mp4: AccessDenied Access Denied.",
      );
    });

    it("answers none of a batch whose request failed", async () => {
      client.removeObjects.mockRejectedValue(new Error("socket hang up"));

      await expect(s3.removeKeys(["clips/a.mp4"])).resolves.toEqual([]);
      expect(logger.error).toHaveBeenCalledWith(
        "unable to remove 1 object(s): socket hang up",
      );
    });
  });
});
