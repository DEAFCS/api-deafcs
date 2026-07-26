import {
  BadRequestException,
  Body,
  Controller,
  Post,
  Get,
  InternalServerErrorException,
  Param,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  ForbiddenException,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import { HasuraAction } from "../hasura/hasura.controller";
import { SystemService } from "src/system/system.service";
import { SystemSettingName } from "src/system/enums/SystemSettingName";
import { isRoleAbove } from "src/utilities/isRoleAbove";
import { signUploadToken } from "../steam-match-history/uploadToken";
import { S3Service } from "../s3/s3.service";
import { User } from "../auth/types/User";
import { e_player_roles_enum } from "generated";
import { NewsService } from "./news.service";

// Videos are much bigger than the images this endpoint was originally built
// for, so they get their own caps and a multipart bypass for anything too big
// to proxy through Cloudflare (~100MB, same constraint the events/demo
// upload flows work around).
const VIDEO_MAX_SIZE = 1024 * 1024 * 1024; // 1GB
const DIRECT_MAX_SIZE = 90 * 1024 * 1024;
const UPLOAD_CHUNK_SIZE = 64 * 1024 * 1024;

@Controller("news")
export class NewsController {
  private readonly logger = new Logger(NewsController.name);

  constructor(
    private readonly news: NewsService,
    private readonly system: SystemService,
    private readonly s3: S3Service,
  ) {}

  @HasuraAction()
  public async newsPostsAdmin(data: { user?: User }) {
    await this.assertCanPost(data.user);
    return await this.news.listPosts();
  }

  @HasuraAction()
  public async newsPostAdmin(data: { id: string; user?: User }) {
    await this.assertCanPost(data.user);
    return await this.news.getPost(data.id);
  }

  @HasuraAction()
  public async saveNewsPost(data: {
    id?: string | null;
    title: string;
    teaser?: string | null;
    cover_image_url?: string | null;
    content_markdown: string;
    user?: User;
  }) {
    const user = await this.assertCanPost(data.user);
    return await this.news.savePost(
      {
        id: data.id,
        title: data.title,
        teaser: data.teaser,
        cover_image_url: data.cover_image_url,
        content_markdown: data.content_markdown,
      },
      user.steam_id,
    );
  }

  @HasuraAction()
  public async setNewsPostStatus(data: {
    id: string;
    status: string;
    user?: User;
  }) {
    await this.assertCanPost(data.user);
    return await this.news.setStatus(data.id, data.status);
  }

  @HasuraAction()
  public async deleteNewsPost(data: { id: string; user?: User }) {
    await this.assertCanPost(data.user);
    await this.news.deletePost(data.id);
    return { success: true };
  }

  @Post("upload")
  @UseInterceptors(FileInterceptor("file"))
  public async upload(
    @Req() request: Request,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          // Ceiling for anything posted directly through the API (images and
          // small videos alike) — Cloudflare caps proxied bodies at ~100MB.
          // Bigger videos use the /initiate multipart bypass below instead.
          new MaxFileSizeValidator({ maxSize: DIRECT_MAX_SIZE }),
          new FileTypeValidator({
            fileType: /image\/(png|jpeg|webp|gif)|video\/mp4/,
          }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    await this.assertCanPost(request.user as User | undefined);

    if (file.mimetype === "video/mp4") {
      if (!this.hasValidMagicBytes(file.buffer.subarray(0, 12))) {
        throw new BadRequestException("file content does not match its type");
      }
      const filename = await this.news.uploadVideo(file.buffer, file.mimetype);
      return { success: true, filename };
    }

    // Images keep their original, tighter 10MB cap.
    if (file.size > 10 * 1024 * 1024) {
      throw new BadRequestException("file exceeds 10MB limit");
    }

    const filename = await this.news.uploadImage(file.buffer, file.mimetype);
    return { success: true, filename };
  }

  @Post("video/initiate")
  public async initiateVideoUpload(
    @Req() request: Request,
    @Body() body: { fileName?: string; fileSize?: number },
  ): Promise<{
    uploadId: string;
    key: string;
    chunkSize: number;
    parts: Array<{ partNumber: number; url: string }>;
  }> {
    await this.assertCanPost(request.user as User | undefined);

    const extension = (body.fileName ?? "").toLowerCase().split(".").pop();
    if (extension !== "mp4") {
      throw new BadRequestException("expected an .mp4 file");
    }

    const fileSize = Number(body.fileSize);
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      throw new BadRequestException("invalid file size");
    }
    if (fileSize <= DIRECT_MAX_SIZE) {
      // Small files must use the plain /upload endpoint — the multipart
      // bypass exists only for bodies too big to proxy through Cloudflare.
      throw new BadRequestException("file is small enough to upload directly");
    }
    if (fileSize > VIDEO_MAX_SIZE) {
      throw new BadRequestException("file exceeds 1GB limit");
    }

    const filename = this.news.generateFilename("mp4");
    const key = this.news.mediaKey(filename);
    const uploadId = await this.s3.createMultipartUpload(key);
    const partCount = Math.ceil(fileSize / UPLOAD_CHUNK_SIZE);
    const workerUrl = await this.news.getCloudflareWorkerUrl();

    // Cloudflare-worker deployments (B2-backed storage) must route part PUTs
    // through the worker: it answers the CORS preflight and signs the B2
    // write itself. Each part URL carries a short-lived HMAC token bound to
    // this key+uploadId so the worker never signs arbitrary writes (same
    // scheme as the demo/event-media upload flows).
    let uploadToken: string | null = null;
    if (workerUrl) {
      const signingSecret = process.env.S3_SECRET;
      if (!signingSecret) {
        throw new InternalServerErrorException(
          "S3_SECRET is not configured; cannot authorize worker uploads",
        );
      }
      uploadToken = signUploadToken(signingSecret, key, uploadId);
    }

    const parts: Array<{ partNumber: number; url: string }> = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      parts.push({
        partNumber,
        url: workerUrl
          ? `${workerUrl}/${key}?partNumber=${partNumber}&uploadId=${encodeURIComponent(uploadId)}&token=${encodeURIComponent(uploadToken!)}`
          : await this.s3.getPresignedPartUrl(key, uploadId, partNumber),
      });
    }

    return { uploadId, key, chunkSize: UPLOAD_CHUNK_SIZE, parts };
  }

  @Post("video/complete")
  public async completeVideoUpload(
    @Req() request: Request,
    @Body() body: { uploadId?: string; key?: string },
  ): Promise<{ success: boolean; filename: string }> {
    await this.assertCanPost(request.user as User | undefined);
    const { key, filename } = this.assertVideoKey(body.key);
    if (!body.uploadId) {
      throw new BadRequestException("uploadId required");
    }

    try {
      await this.s3.completeMultipartUpload(key, body.uploadId);
    } catch (error) {
      try {
        await this.s3.abortMultipartUpload(key, body.uploadId);
      } catch (abortError) {
        this.logger.warn(
          `abort after failed complete key=${key}: ${abortError}`,
        );
      }
      throw new BadRequestException(
        `could not assemble upload: ${(error as Error)?.message ?? error}`,
      );
    }

    // The size cap on /initiate trusts the client-claimed fileSize, so
    // enforce the real assembled size here — presigned part PUTs aren't capped.
    const { size } = await this.s3.stat(key);
    if (size > VIDEO_MAX_SIZE) {
      await this.s3.remove(key);
      throw new BadRequestException("file exceeds 1GB limit");
    }

    const header = await this.s3.readPrefix(key, 12);
    if (!this.hasValidMagicBytes(header)) {
      await this.s3.remove(key);
      throw new BadRequestException("file content does not match its type");
    }

    return { success: true, filename };
  }

  @Post("video/abort")
  public async abortVideoUpload(
    @Req() request: Request,
    @Body() body: { uploadId?: string; key?: string },
  ): Promise<{ success: boolean }> {
    await this.assertCanPost(request.user as User | undefined);
    const { key } = this.assertVideoKey(body.key);
    if (!body.uploadId) {
      throw new BadRequestException("uploadId required");
    }
    try {
      await this.s3.abortMultipartUpload(key, body.uploadId);
    } catch (error) {
      this.logger.warn(`abort multipart upload failed key=${key}: ${error}`);
    }
    return { success: true };
  }

  @Get("video/:filename")
  public async serveVideo(
    @Param("filename") filename: string,
    @Req() request: Request,
    @Res() response: Response,
  ) {
    if (!/^[A-Za-z0-9._-]+\.mp4$/.test(filename)) {
      throw new NotFoundException("video not found");
    }
    await this.streamVideo(this.news.mediaKey(filename), request, response);
  }

  @Post(":slug/view")
  public async trackView(@Param("slug") slug: string) {
    await this.news.trackView(slug);
    return { success: true };
  }

  @Get("image/:filename")
  public async serveImage(
    @Param("filename") filename: string,
    @Res() res: Response,
  ) {
    if (!/^[A-Za-z0-9._-]+$/.test(filename)) {
      throw new NotFoundException("Image not found");
    }

    const result = await this.news.getImageStream(filename);
    if (!result) {
      throw new NotFoundException("Image not found");
    }

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    if (result.etag) {
      res.setHeader("ETag", result.etag);
    }

    // Without these handlers an S3 stream error would throw an unhandled
    // 'error' event (crashing the process), and a client that disconnects
    // mid-download would leave the upstream stream open (fd leak).
    result.stream.on("error", (error: Error) => {
      this.logger.error(
        `error streaming news image ${filename}: ${error?.message}`,
        error?.stack,
      );
      result.stream.destroy();
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.destroy();
      }
    });
    res.on("close", () => {
      result.stream.destroy();
    });

    result.stream.pipe(res);
  }

  private async assertCanPost(user?: User): Promise<User> {
    if (!user) {
      throw new ForbiddenException("Authentication required");
    }

    const postRole = (await this.system.getSetting(
      SystemSettingName.PostNewsRole,
      "administrator",
    )) as e_player_roles_enum;

    if (!isRoleAbove(user.role, postRole)) {
      throw new ForbiddenException(
        "You do not have permission to post news",
      );
    }

    return user;
  }

  private assertVideoKey(key?: string): { key: string; filename: string } {
    const expectedPrefix = `${this.news.mediaKey("")}`;
    if (
      !key ||
      !key.startsWith(expectedPrefix) ||
      !/^[a-zA-Z0-9/_-]+\.mp4$/.test(key)
    ) {
      throw new BadRequestException("invalid upload key");
    }
    const filename = key.slice(expectedPrefix.length);
    if (filename.includes("/")) {
      throw new BadRequestException("invalid upload key");
    }
    return { key, filename };
  }

  // MP4 files start with a size field followed by an "ftyp" box.
  private hasValidMagicBytes(header: Buffer): boolean {
    return header.length >= 8 && header.subarray(4, 8).toString() === "ftyp";
  }

  private async streamVideo(
    key: string,
    request: Request,
    response: Response,
  ) {
    let stat;
    try {
      stat = await this.s3.stat(key);
    } catch (error) {
      if ((error as { code?: string })?.code === "NotFound") {
        response.status(404).json({ error: "not found" });
        return;
      }
      this.logger.error(`failed to stat ${key}: ${(error as Error)?.message}`);
      response.status(500).json({ error: "internal" });
      return;
    }

    const size = stat.size;
    response.setHeader("Content-Type", "video/mp4");
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");

    const rangeHeader = request.headers.range;
    const range = rangeHeader ? this.parseRange(rangeHeader, size) : null;

    if (rangeHeader && !range) {
      response.setHeader("Content-Range", `bytes */${size}`);
      response.status(416).end();
      return;
    }

    try {
      if (range) {
        const length = range.end - range.start + 1;
        response.status(206);
        response.setHeader(
          "Content-Range",
          `bytes ${range.start}-${range.end}/${size}`,
        );
        response.setHeader("Content-Length", String(length));
        const stream = await this.s3.getPartial(key, range.start, length);
        this.pipeWithCleanup(stream, response);
      } else {
        response.status(200);
        response.setHeader("Content-Length", String(size));
        const stream = await this.s3.get(key);
        this.pipeWithCleanup(stream, response);
      }
    } catch (error) {
      this.logger.error(
        `failed to stream ${key}: ${(error as Error)?.message}`,
      );
      if (!response.headersSent) {
        response.status(500).json({ error: "internal" });
      } else {
        response.destroy();
      }
    }
  }

  private parseRange(
    header: string,
    size: number,
  ): { start: number; end: number } | null {
    const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!match) return null;
    const startStr = match[1];
    const endStr = match[2];
    let start: number;
    let end: number;
    if (startStr === "" && endStr === "") return null;
    if (startStr === "") {
      const suffix = parseInt(endStr, 10);
      if (!Number.isFinite(suffix) || suffix <= 0) return null;
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = parseInt(startStr, 10);
      end = endStr === "" ? size - 1 : parseInt(endStr, 10);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (start < 0 || end < start || start >= size) return null;
    if (end >= size) end = size - 1;
    return { start, end };
  }

  private pipeWithCleanup(stream: NodeJS.ReadableStream, response: Response) {
    response.on("close", () => {
      (stream as unknown as { destroy?: () => void }).destroy?.();
    });
    stream.pipe(response);
  }
}
