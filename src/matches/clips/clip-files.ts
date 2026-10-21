import { S3Service } from "../../s3/s3.service";

const CLIP_PREFIX = "clips/";

// DEAFCS: a clip's video and poster frame live at the keys stored on its row,
// `clips/<owner or system>/<render job id>.mp4|.jpg` (see
// ClipsService.GetClipS3Key). Upstream deleted `clips/<owner>/<clip id>`, a
// prefix no object has (the clip id is not the render job id, and auto clips
// have no owner), so every deleted clip left both files behind.
//
// Removes exactly the row's keys, never anything outside clips/. Returns false
// when a file could not be removed and is still there, so the caller can keep
// the row instead of losing track of the file.
export async function removeClipFiles(
  s3: S3Service,
  clip: { file?: string | null; thumbnail_url?: string | null },
): Promise<boolean> {
  let removed = true;

  for (const key of [clip.file, clip.thumbnail_url]) {
    if (!key || !key.startsWith(CLIP_PREFIX)) {
      continue;
    }

    if (await s3.remove(key)) {
      continue;
    }

    // remove() also answers false for a key that was already gone. A key we
    // cannot check counts as still there.
    try {
      if (await s3.has(key)) {
        removed = false;
      }
    } catch {
      removed = false;
    }
  }

  return removed;
}
