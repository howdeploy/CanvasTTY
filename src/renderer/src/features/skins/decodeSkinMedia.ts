import { inspectSkinMedia, SKIN_MEDIA_MIME, type SkinMediaInfo } from "../../../../shared/skinMedia";
import { validateWallpaperDimensions } from "../../../../shared/wallpaper";
export interface DecodedSkinMedia { bytes: Uint8Array; media: SkinMediaInfo; width: number; height: number }
export async function decodeSkinMedia(bytes: Uint8Array): Promise<DecodedSkinMedia> {
  const media = inspectSkinMedia(bytes);
  if (media.width && media.height) validateWallpaperDimensions(media.width, media.height);
  if (media.format !== "mp4" && media.format !== "webm" && bytes.length > 20 * 1024 * 1024) throw new Error("Images: max 20 MB.");
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: SKIN_MEDIA_MIME[media.format] }));
  const video = media.format === "mp4" || media.format === "webm" ? document.createElement("video") : null;
  const image = video ? null : new Image();
  try {
    const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Media decoding timed out.")), 15000);
      const done = (): void => { clearTimeout(timer); resolve({ width: video?.videoWidth ?? image!.naturalWidth, height: video?.videoHeight ?? image!.naturalHeight }); };
      const fail = (): void => { clearTimeout(timer); reject(new Error("Cannot decode this media. Use H.264 MP4, VP8/VP9 WebM, GIF, WebP or PNG.")); };
      if (video) { video.onloadedmetadata = done; video.onerror = fail; video.preload = "metadata"; video.muted = true; video.src = url; }
      else { image!.onload = done; image!.onerror = fail; image!.src = url; }
    });
    validateWallpaperDimensions(size.width, size.height);
    return { bytes, media: { ...media, ...size }, ...size };
  } finally { if (video) { video.removeAttribute("src"); video.load(); } if (image) image.src = ""; URL.revokeObjectURL(url); }
}
