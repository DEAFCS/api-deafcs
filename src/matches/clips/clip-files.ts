import { S3Service } from "../../s3/s3.service";

const CLIP_PREFIX = "clips/";
// Every demo of a match lives under demos/<match id>/ (see deleteDemosForMatch).
const DEMO_MATCH_PREFIX = /^demos\/[0-9a-f-]{36}\/$/;

// Files whose database rows are already gone: exact clip keys, and the demo
// folders of deleted matches.
export type DeletedFiles = { keys: string[]; prefixes: string[] };

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
    if (!(await removeClipKey(s3, key))) {
      removed = false;
    }
  }

  return removed;
}

// For files whose rows are already deleted, nothing is left to retry from but
// this answer: returns what could not be removed and is still there.
// Never touches a key outside clips/ or a prefix other than a match's demos.
export async function removeDeletedFiles(
  s3: S3Service,
  files: DeletedFiles,
): Promise<DeletedFiles> {
  const left: DeletedFiles = { keys: [], prefixes: [] };

  for (const key of new Set(files.keys)) {
    if (!(await removeClipKey(s3, key))) {
      left.keys.push(key);
    }
  }

  for (const prefix of new Set(files.prefixes)) {
    if (!DEMO_MATCH_PREFIX.test(prefix)) {
      continue;
    }
    try {
      await s3.removePrefix(prefix);
    } catch {
      left.prefixes.push(prefix);
    }
  }

  return left;
}

async function removeClipKey(
  s3: S3Service,
  key: string | null | undefined,
): Promise<boolean> {
  if (!key || !key.startsWith(CLIP_PREFIX)) {
    return true;
  }

  if (await s3.remove(key)) {
    return true;
  }

  // remove() also answers false for a key that was already gone. A key we
  // cannot check counts as still there.
  try {
    return !(await s3.has(key));
  } catch {
    return false;
  }
}
