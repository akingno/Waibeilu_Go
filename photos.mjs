import sharp from "sharp";

export const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
export const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const formats = { jpeg: ["image/jpeg", "jpg"], png: ["image/png", "png"], webp: ["image/webp", "webp"] };

export class PhotoError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function readPhoto(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    let chunks = [];
    req.on("data", chunk => {
      size += chunk.length;
      if (size >= MAX_PHOTO_BYTES) {
        tooLarge = true;
        chunks = [];
        reject(new PhotoError(413, "请选择小于 6MB 的图片"));
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
    req.on("aborted", () => reject(new PhotoError(400, "上传已中断，请重新选择图片")));
  });
}

export async function preparePhoto(bytes, contentType, name = "photo") {
  if (!bytes.length) throw new PhotoError(400, "不能上传空文件");
  if (bytes.length >= MAX_PHOTO_BYTES) throw new PhotoError(413, "请选择小于 6MB 的图片");
  if (!PHOTO_TYPES.has(contentType)) throw new PhotoError(415, "仅支持 JPG、PNG 和 WebP 图片");
  try {
    const image = sharp(bytes, { limitInputPixels: 60_000_000, failOn: "warning" });
    const metadata = await image.metadata();
    const format = formats[metadata.format];
    if (!format || format[0] !== contentType) {
      throw new PhotoError(415, "文件内容与图片格式不符，仅支持 JPG、PNG 和 WebP");
    }
    const thumbnail = await image.autoOrient()
      .resize({ width: 480, height: 480, fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 }).toBuffer();
    const rotated = metadata.orientation >= 5;
    const filename = name.replace(/[/\\\u0000-\u001f\u007f]/g, "_").slice(0, 150).trim() || `photo.${format[1]}`;
    return {
      thumbnail, filename, mime: format[0], extension: format[1],
      width: rotated ? metadata.height : metadata.width,
      height: rotated ? metadata.width : metadata.height,
    };
  } catch (error) {
    if (error instanceof PhotoError) throw error;
    throw new PhotoError(400, "图片无法读取或像素过大，请选择有效的 JPG、PNG 或 WebP 图片（不超过 6000 万像素）");
  }
}
