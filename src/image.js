// -----------------------------------------------------------------------------
// Camera snapshots, made to fit Gladys: an `image/jpg;base64,…` string of
// 150 KB at most (the whole string, SDK MAX_CAMERA_IMAGE_SIZE).
//
// No image decoding in the container: image.cgi takes a `resolution` and a
// `compression` (0 to 100), and the camera scales and encodes the snapshot
// itself. The integration asks for at most 640 px wide at compression 30;
// when that is still too large (a busy scene, a noisy night image), once
// more at compression 60 and a smaller resolution.
// -----------------------------------------------------------------------------

export const CAMERA_PREFIX = 'image/jpg;base64,';
export const MAX_CAMERA_IMAGE = 150 * 1024; // the full string, prefix included

/** The `image/jpg;base64,…` string of JPEG bytes. */
export const asCameraImage = (bytes) => `${CAMERA_PREFIX}${Buffer.from(bytes).toString('base64')}`;

export const fitsCamera = (bytes) =>
  CAMERA_PREFIX.length + Math.ceil(bytes.length / 3) * 4 <= MAX_CAMERA_IMAGE;

export const isJpeg = (bytes) =>
  Buffer.isBuffer(bytes) && bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8;

/** The second try: a resolution of the list half as wide, or the smallest one. */
export function smallerResolution(resolution, list) {
  const sizes = String(list ?? '')
    .split(',')
    .map((entry) => entry.trim().match(/^(\d+)x(\d+)$/))
    .filter(Boolean)
    .map(([text, width]) => ({ text, width: Number(width) }));
  if (sizes.length === 0) {
    return null;
  }
  const current = Number(String(resolution ?? '').split('x')[0]) || sizes[0].width;
  const smaller = sizes.filter((size) => size.width <= current / 2);
  if (smaller.length > 0) {
    return smaller.reduce((best, size) => (size.width > best.width ? size : best)).text;
  }
  return sizes.reduce((best, size) => (size.width < best.width ? size : best)).text;
}

/**
 * A snapshot that fits Gladys.
 * @param {(options: { resolution, compression }) => Promise<Buffer>} take
 * @param {object} info the device description (snapshotResolution, resolutions)
 * @returns {Promise<string>} the camera image string
 */
export async function fittedSnapshot(take, info) {
  let bytes = await take({ resolution: info.snapshotResolution ?? null, compression: 30 });
  if (!isJpeg(bytes)) {
    throw new Error('The snapshot is not a JPEG image');
  }
  if (!fitsCamera(bytes)) {
    bytes = await take({
      resolution: smallerResolution(info.snapshotResolution, info.resolutions),
      compression: 60,
    });
    if (!isJpeg(bytes) || !fitsCamera(bytes)) {
      throw new Error('The snapshot stays larger than the 150 KB Gladys takes');
    }
  }
  return asCameraImage(bytes);
}
