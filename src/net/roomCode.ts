/**
 * Shareable room codes. Every human-facing room (custom rooms, duo record runs)
 * uses a randomly generated 6-character code instead of a user-typed one, so
 * codes are unguessable, uniform, and — critically — can't spell anything
 * inappropriate.
 *
 * ALPHABET: uppercase letters + digits, but with **all vowels removed** (plus the
 * ambiguous 0/1/O/I/L). No vowels ⇒ no dictionary words ⇒ no profanity can form,
 * which is a far more robust guarantee than a blocklist alone. We still run a
 * small blocklist (with leet-folding of digits) as a second layer for the rare
 * no-vowel slur / offensive number sequence, regenerating on a hit.
 *
 * Collision: 28^6 ≈ 4.8e8 codes. For this app's scale a client-side random pick
 * is effectively unique; rooms are also ephemeral (gone when empty).
 */

export const ROOM_CODE_ALPHABET = '23456789BCDFGHJKMNPQRSTVWXYZ'; // no vowels, no 0/1/O/I/L
export const ROOM_CODE_LENGTH = 6;

// substrings that must never appear in a code (checked on the raw code AND a
// leet-folded copy). Kept short: the vowel-free alphabet already blocks words.
const BLOCKLIST = [
  'FCK', 'FUK', 'FUX', 'SHT', 'FGT', 'FQ', 'CNT', 'PRK', 'PN', // crude no-vowel forms
  '88', '666', '420', '69', '187', // offensive / drug / hate number sequences
  'KKK', 'NZ', 'SS',
];

/** fold common digit leetspeak to letters so "5H7" is caught like "SHT" */
function leetFold(s: string): string {
  return s
    .replace(/5/g, 'S')
    .replace(/3/g, 'E')
    .replace(/1/g, 'I')
    .replace(/0/g, 'O')
    .replace(/4/g, 'A')
    .replace(/7/g, 'T')
    .replace(/8/g, 'B')
    .replace(/6/g, 'G');
}

/** true if the code contains a blocklisted substring (raw or leet-folded) */
function isInappropriate(code: string): boolean {
  const folded = leetFold(code);
  return BLOCKLIST.some((bad) => code.includes(bad) || folded.includes(bad));
}

/** uniform random index in [0, n) using crypto when available (rejection
 * sampling to avoid modulo bias); falls back to Math.random */
function randIndex(n: number): number {
  const g = typeof globalThis !== 'undefined' ? (globalThis.crypto as Crypto | undefined) : undefined;
  if (g?.getRandomValues) {
    const max = Math.floor(256 / n) * n; // largest multiple of n ≤ 256
    const buf = new Uint8Array(1);
    let v = 0;
    do {
      g.getRandomValues(buf);
      v = buf[0];
    } while (v >= max);
    return v % n;
  }
  return Math.floor(Math.random() * n);
}

/** generate a fresh, appropriate 6-char room code */
export function generateRoomCode(): string {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) code += ROOM_CODE_ALPHABET[randIndex(ROOM_CODE_ALPHABET.length)];
    if (!isInappropriate(code)) return code;
  }
  // astronomically unlikely fallback (all attempts blocked): a fixed safe code
  return 'PLAY42';
}

/** normalize a user-typed join code: uppercase, strip anything outside the
 * alphabet (spaces, dashes, vowels people might add by mistake) */
export function normalizeRoomCode(raw: string): string {
  const up = raw.toUpperCase();
  let out = '';
  for (const ch of up) if (ROOM_CODE_ALPHABET.includes(ch)) out += ch;
  return out.slice(0, ROOM_CODE_LENGTH);
}

/** a well-formed room code: exactly 6 chars, all from the alphabet, not blocked */
export function isValidRoomCode(code: string): boolean {
  if (code.length !== ROOM_CODE_LENGTH) return false;
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return false;
  return !isInappropriate(code);
}
