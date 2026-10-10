/**
 * How long a download's object URL stays alive after the click (ms).
 *
 * `a.click()` only STARTS the download, and the URL pins the blob until it is revoked. Revoking
 * on the same tick — or one tick later — can cut the transfer off before the browser has taken
 * its own handle on the blob, which Safari and Firefox are slow enough to lose on a
 * tens-of-megabytes video. A minute is far past any hand-off and holds the memory only briefly.
 */
export const BLOB_URL_TTL_MS = 60_000;

/**
 * Hand a finished blob to the browser as a download.
 *
 * The ONE place the object-URL lifetime is handled: the replay video and JSON exports, the
 * account data export and the admin CSVs all come through here. Two of those used to revoke
 * the URL immediately after `click()`, which is exactly what can cut a download off.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_TTL_MS);
}
