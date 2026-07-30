import {
  Controller,
  Delete,
  FileTypeValidator,
  ForbiddenException,
  Get,
  MaxFileSizeValidator,
  NotFoundException,
  Param,
  ParseFilePipe,
  ParseIntPipe,
  Post,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { Request, Response } from "express";
import { AwardsService } from "./awards.service";
import { User } from "../auth/types/User";

// Award artwork uploaded before the awards rename is served immutable, so
// links to /trophies/<filename> stay in caches and embeds indefinitely.
@Controller("trophies")
export class TrophiesLegacyController {
  constructor(private readonly awards: AwardsService) {}

  @Post(":tournamentId/:placement")
  @UseInterceptors(FileInterceptor("file"))
  public async upload(
    @Req() request: Request,
    @Param("tournamentId") tournamentId: string,
    @Param("placement", ParseIntPipe) placement: number,
    @UploadedFile(
      new ParseFilePipe({
        validators: [
          new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: /image\/(png|jpeg|webp)/ }),
        ],
      }),
    )
    file: Express.Multer.File,
  ) {
    const user = this.requireUser(request);
    await this.awards.requireOrganizer(tournamentId, user);
    const path = await this.awards.uploadTournamentAwardImage(
      tournamentId,
      placement,
      file.buffer,
      file.mimetype,
    );
    return { success: true, path };
  }

  @Delete(":tournamentId/:placement")
  public async remove(
    @Req() request: Request,
    @Param("tournamentId") tournamentId: string,
    @Param("placement", ParseIntPipe) placement: number,
  ) {
    const user = this.requireUser(request);
    await this.awards.requireOrganizer(tournamentId, user);
    await this.awards.removeTournamentAwardImage(tournamentId, placement);
    return { success: true };
  }

  @Get(":filename")
  public async serve(
    @Param("filename") filename: string,
    @Res() res: Response,
  ) {
    if (!/^[A-Za-z0-9._-]+$/.test(filename) || filename.includes("..")) {
      throw new NotFoundException("Award image not found");
    }

    const result = await this.awards.getStream(filename);
    if (!result) {
      throw new NotFoundException("Award image not found");
    }

    res.setHeader("Content-Type", result.contentType);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    if (result.etag) {
      res.setHeader("ETag", result.etag);
    }

    result.stream.pipe(res);
  }

  private requireUser(request: Request): User {
    const user = request.user as User | undefined;
    if (!user) {
      throw new ForbiddenException("Authentication required");
    }
    return user;
  }
}
