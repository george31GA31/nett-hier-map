// Pure validation is shared with the automated abuse/authorization tests.
export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
export const BUCKET = "sticker-photos";
export const MAX_PHOTO = 6 * 1024 * 1024;
export const PUBLIC_FIELDS =
  "id,lat,lng,place,country,country_code,note,spotted_on,image_url,added_by,owner_id,created_at";
const reasons = new Set([
  "Not there anymore",
  "Wrong location",
  "Wrong variation of the Nett Hier / Not Bad sticker",
  "Inappropriate",
  "Too damaged",
  "Other",
]);
export function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) throw new ApiError(400, "Invalid sighting reference.");
  return value;
}
export function coordinates(lat: unknown, lng: unknown) {
  if (
    typeof lat !== "number" || typeof lng !== "number" ||
    !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  ) throw new ApiError(400, "Choose a valid location.");
  return { lat, lng };
}
function text(value: unknown, max: number, required = false): string | null {
  if (value == null && !required) return null;
  if (
    typeof value !== "string" || value.trim().length > max ||
    (required && !value.trim())
  ) throw new ApiError(400, "Check the length of the submitted text.");
  return value.trim() || null;
}
export function sighting(value: Record<string, unknown>) {
  const date = text(value.spotted_on, 10, true)!;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  ) throw new ApiError(400, "Choose a valid date.");
  const cc = text(value.country_code, 2);
  if (cc && !/^[A-Z]{2}$/.test(cc)) {
    throw new ApiError(400, "Invalid country code.");
  }
  return {
    ...coordinates(value.lat, value.lng),
    place: text(value.place, 120),
    country: text(value.country, 100),
    country_code: cc,
    note: text(value.note, 500),
    added_by: text(value.added_by, 80, true),
    spotted_on: date,
  };
}
export function report(value: Record<string, unknown>) {
  if (!reasons.has(String(value.reason))) {
    throw new ApiError(400, "Choose a report reason.");
  }
  return {
    spot_id: uuid(value.spot_id),
    reason: String(value.reason),
    comment: value.reason === "Other" ? text(value.comment, 50) : null,
  };
}
export function photoPath(value: string) {
  if (!/^(managed\/)?[a-zA-Z0-9_-]+\.jpg$/.test(value)) {
    throw new ApiError(400, "Invalid photo reference.");
  }
  return value;
}
export function jpeg(bytes: Uint8Array) {
  if (
    bytes.length < 4 || bytes.length > MAX_PHOTO || bytes[0] !== 255 ||
    bytes[1] !== 216 || bytes[2] !== 255 || bytes[bytes.length - 2] !== 255 ||
    bytes[bytes.length - 1] !== 217
  ) throw new ApiError(400, "Please upload a JPEG under 6 MB.");
}
export function bounds(value: Record<string, unknown>) {
  const south = Number(value.south),
    north = Number(value.north),
    west = Number(value.west),
    east = Number(value.east);
  coordinates(south, west);
  coordinates(north, east);
  if (south > north) throw new ApiError(400, "Invalid map bounds.");
  return { south, north, west, east };
}

// Keep JPEG scan data intact; strip metadata-bearing APP1..APP15 and comments.
// Read SOF before decoding to reject giant/decompression-bomb dimensions.
export function sanitizeJpeg(bytes: Uint8Array): Uint8Array {
  jpeg(bytes);
  let pos = 2;
  let dimensions = false;
  const segments: Uint8Array[] = [bytes.slice(0, 2)];
  while (pos < bytes.length - 2) {
    const start = pos;
    if (bytes[pos++] !== 255) throw new ApiError(400, "Invalid JPEG photo.");
    while (bytes[pos] === 255) pos++;
    const marker = bytes[pos++];
    if (marker === 0xda) {
      if (!dimensions) throw new ApiError(400, "Invalid JPEG dimensions.");
      segments.push(bytes.slice(start));
      const out = new Uint8Array(segments.reduce((n, s) => n + s.length, 0));
      let at = 0;
      for (const s of segments) {
        out.set(s, at);
        at += s.length;
      }
      return out;
    }
    if (pos + 2 > bytes.length) break;
    const length = (bytes[pos] << 8) | bytes[pos + 1];
    if (length < 2 || pos + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker)) {
      if (length < 8) throw new ApiError(400, "Invalid JPEG dimensions.");
      const h = (bytes[pos + 3] << 8) | bytes[pos + 4],
        w = (bytes[pos + 5] << 8) | bytes[pos + 6];
      if (!w || !h || w > 4000 || h > 4000 || w * h > 16000000) {
        throw new ApiError(
          400,
          "Please choose a photo up to 4000 pixels on each side.",
        );
      }
      dimensions = true;
    }
    if (!(marker >= 0xe1 && marker <= 0xef) && marker !== 0xfe) {
      segments.push(bytes.slice(start, pos + length));
    }
    pos += length;
  }
  throw new ApiError(400, "Could not read that JPEG photo.");
}
