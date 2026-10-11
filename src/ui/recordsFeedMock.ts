import type { RecentRecord } from '../net/protocol';

/**
 * REVIEW FIXTURE for the Records hub: `?mock=1` on a DEV build shows these rows with no game server.
 * `import.meta.env.DEV` is a build-time constant, so a production bundle drops the whole branch;
 * nothing here ever reaches a player, and nothing real is represented (the names are invented).
 */
/** read ONCE, at load: the app rewrites the address bar to its canonical path, which drops the query */
const ON = import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).get('mock') === '1';
export function mockFeedOn(): boolean {
  return ON;
}

const ago = (mins: number): string => new Date(Date.now() - mins * 60_000).toISOString();

export const MOCK_FEED: RecentRecord[] = [
  { userId: 'm1', handle: 'Ada Lin', username: 'adalin', partnerHandle: null, partnerUsername: null, mode: 'solo', score: 412, rank: 1, createdAt: ago(12), replayId: 'mock-1' },
  { userId: 'm2', handle: 'Bo Okafor', username: 'bookafor', partnerHandle: 'Cy Reyes', partnerUsername: 'cyreyes', mode: 'duo', score: 688, rank: 1, createdAt: ago(95), replayId: 'mock-2' },
  { userId: 'm3', handle: 'Dee Park', username: 'deepark', partnerHandle: null, partnerUsername: null, mode: 'solo', score: 398, rank: 2, createdAt: ago(60 * 7), replayId: 'mock-3' },
  { userId: 'm4', handle: 'Eli Novak', username: 'elinovak', partnerHandle: null, partnerUsername: null, mode: 'solo', score: 371, rank: 3, createdAt: ago(60 * 26), replayId: null },
  { userId: 'm5', handle: 'Fay Adeyemi', username: 'fayadeyemi', partnerHandle: 'Gus Holm', partnerUsername: 'gusholm', mode: 'duo', score: 640, rank: 2, createdAt: ago(60 * 52), replayId: 'mock-5' },
  { userId: 'm6', handle: 'Ada Lin', username: 'adalin', partnerHandle: null, partnerUsername: null, mode: 'solo', score: 355, rank: 2, createdAt: ago(60 * 24 * 3), replayId: 'mock-6' },
];
