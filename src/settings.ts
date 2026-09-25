import type { Alliance, GameId, GameLoadout, GameSettings, PerfDisplay, PracticeSeat, PracticeSeats } from './types';
import {
  DEFAULT_ASSISTS,
  DEFAULT_SPEC,
  coerceSpec,
  coerceAssists,
  coerceStartPose,
  defaultAssistsFor,
  PLAYER_ASSISTS,
  type RobotSetup,
} from './sim/spawn';
import { MAX_SAVED_ROBOTS, MAX_SAVED_STARTS_SUPPORTER } from './config';
import { GAME_IDS, isGameId } from './games/types';
import { simModuleFor } from './games/sim';
import type { StartSel, StartPose } from './types';

/** how many named start anchors a game has (for clamping startIndex per game) —
 * the module owns the count, so a new game does not touch this file. */
const startPoseCount = (game: GameId): number => simModuleFor(game).startPoseCount;
import { cloneBindings, DEFAULT_BINDINGS, mergeBindings } from './input/bindings';
import { clamp } from './math';

// the key itself comes from the registry every privacy surface reads (src/storageKeys.ts)
import { SETTINGS_KEY as STORAGE_KEY } from './storageKeys';

/**
 * The touch-control layout (centres as viewport fractions), editable + persisted per device.
 *
 * ⚠️ THESE VALUES ARE THE "UNTOUCHED" SENTINEL, NOT THE ARRANGEMENT ANY MORE. A fraction
 * cannot be right in both orientations at once — these were tuned for landscape, and in
 * portrait `shoot` and `intake` were 60 px apart with radii of 41 and 32, so they overlapped,
 * while the drive base's left edge hung off the screen. `src/ui/mobileActions.ts` arranges the
 * pad against the LIVE viewport instead, and reads a key here only once it DIFFERS from what
 * is written below — which is exactly "the player has dragged this control". So every
 * customised layout keeps working, and nobody has to hand-tune two sets of numbers.
 */
export const DEFAULT_MOBILE_LAYOUT: GameSettings['mobileLayout'] = {
  drive: { x: 0.13, y: 0.74 },
  turn: { x: 0.87, y: 0.74 },
  shoot: { x: 0.9, y: 0.44 },
  intake: { x: 0.74, y: 0.44 },
  catalyst: { x: 0.82, y: 0.29 },
  fling: { x: 0.66, y: 0.29 },
  // The HUMAN PLAYER button. Only drawn in BIOBUZZ (`src/games/biobuzz/mobile.ts`), where it
  // sits on the drive thumb's side: it is an alliance action pressed at a cue, and putting it
  // in the scoring thumb's sweep is how a driver spends an entitlement they were saving.
  bbNectar: { x: 0.74, y: 0.16 },
  scale: 1,
};

/**
 * The performance read-out's levels, least→most, as a runtime list.
 *
 * Here rather than in `types.ts` because it is both the COERCER's allowlist and the picker's
 * order, and those two drifting apart is how a level ends up selectable and then discarded on
 * the next load.
 */
export const PERF_DISPLAY_LEVELS: readonly PerfDisplay[] = ['off', 'simple', 'detailed', 'graphs'];

export function defaultSettings(): GameSettings {
  return {
    game: 'decode',
    mode: 'match',
    alliance: 'blue',
    // the ACTIVE assists always MIRROR the robot's own (`spec.assists`) — all ON by default
    assists: { ...(DEFAULT_SPEC.assists ?? defaultAssistsFor()) },
    spec: { ...DEFAULT_SPEC },
    savedRobots: [],
    savedAutos: [],
    startIndex: 0,
    startCat: 'close',
    savedStartPoses: { close: [], far: [] },
    // GATE (index 0, close) + AUDIENCE (index 1, far) are the default per-category picks
    startMemory: { close: { index: 0, pose: null }, far: { index: 1, pose: null } },
    practiceDummies: false,
    // solo practice defaults to the 3D physics (Day 1 seam, `docs/biobuzz/plan-3d.md` §2.1);
    // the player picks '2d' for a casual or low-end run.
    practicePhysics: '3d',
    // OFF by default (plan §6). Practice is where people go to drive their own robot, and a
    // field with three strangers on it is a different exercise from the one they asked for —
    // opting in is one button, opting out of a surprise is a support question.
    practiceBots: 'off',
    audio: {
      volume: { master: 1, game: 1, shoot: 1, intake: 1, gate: 1, beep: 1, alert: 1, voice: 1 },
      sounds: true,
      voice: true,
    },
    bindings: cloneBindings(DEFAULT_BINDINGS),
    autoPath: null, // Default to no auto path loaded
    autoPathEnabled: false, // Default to auto path disabled
    showEventLog: true,
    // SIMPLE, not off (owner, 2026-09-19: "default for performance statistics should include
    // simple ping and fps"). Two numbers on one line in a corner nothing else uses — the cost
    // of it being on for everybody is smaller than the cost of a player who cannot tell a bad
    // connection from a bad machine having to find a setting first.
    perfDisplay: 'simple',
    parkSpeedPct: 30,
    tankControlMode: 'normal',
    mobileLayout: cloneMobileLayout(DEFAULT_MOBILE_LAYOUT),
  };
}

// ---- PRACTICE SEATS (who else is on a practice field) ---------------------------

function coercePracticeSeat(raw: unknown): PracticeSeat | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.kind !== 'none' && r.kind !== 'dummy' && r.kind !== 'ai') return null;
  if (typeof r.tier !== 'string' || r.tier.length > 32) return null;
  return { kind: r.kind, tier: r.tier };
}

/** `game`'s three practice seats, or three None — at the game's default tier, so picking AI on
 *  a fresh seat starts at the difficulty the game itself suggests. */
export function practiceSeatsFor(s: GameSettings, game: GameId): PracticeSeats {
  const stored = s.practiceSeats?.[game];
  if (stored) return stored;
  const tier = simModuleFor(game).bot?.defaultTier ?? 'medium';
  return [
    { kind: 'none', tier },
    { kind: 'none', tier },
    { kind: 'none', tier },
  ];
}

/**
 * THE PRACTICE SEATS AS SETUPS: partner, opponent 1, opponent 2, each None, a Dummy or an AI
 * driver at its own tier — read by Solo practice AND Free drive (`GameController.makeWorld`).
 * The ids, sides and anchors are the format a room has, a 2v2: the partner (id 1) takes the
 * anchor the player is NOT on so the two never overlap, the opponents (2, 3) take the other
 * side's first two.
 *
 * A DUMMY is inert: `passive` makes the sim skip ALL its action compute (turret solve,
 * flywheel, fire, intake) — it only ever exists to be bumped into. An AI seat in a game with no
 * driver is None, the same way the Practice card does not offer one there. An AI seat in FREE
 * DRIVE plays as it would in teleop: there is no clock for it to read, only the field.
 *
 * Returns the setups to append after the player's (id 0) and, per AI robot id, the tier its
 * driver is to be seated at.
 */
export function practiceSetups(
  s: GameSettings,
  game: GameId,
  seed: number,
): { setups: RobotSetup[]; botTiers: Map<number, string> } {
  const botDriver = simModuleFor(game).bot;
  const opp: Alliance = s.alliance === 'blue' ? 'red' : 'blue';
  const places: [id: number, alliance: Alliance, startIndex: number][] = [
    [1, s.alliance, s.startIndex === 1 ? 0 : 1],
    [2, opp, 0],
    [3, opp, Math.min(1, startPoseCount(game) - 1)],
  ];
  const setups: RobotSetup[] = [];
  const botTiers = new Map<number, string>();
  practiceSeatsFor(s, game).forEach((pick, i) => {
    const [id, alliance, startIndex] = places[i];
    if (pick.kind === 'dummy') {
      setups.push({
        id,
        alliance,
        spec: { ...DEFAULT_SPEC, name: `Dummy ${id}`, teamName: 'Practice', teamNumber: 0 },
        assists: { ...DEFAULT_ASSISTS, autoIntake: false, autoFire: false },
        startIndex,
        passive: true,
      });
    } else if (pick.kind === 'ai' && botDriver) {
      // COERCED AT THE POINT OF USE, by the driver that owns the tier list: the stored string
      // is kept verbatim across games (see `coerceSettings`), so it may be a word this game has
      // since renamed. THE ROBOT IS THE DRIVER'S CHOICE: `BotDriver.build` is deterministic in
      // the match seed and the seat, so a restart is a new line-up and a replay carries the
      // specs in its setups; a driver without one keeps the default chassis.
      const tier = botDriver.coerceTier(pick.tier);
      botTiers.set(id, tier);
      setups.push({
        id,
        alliance,
        spec: botDriver.build?.({ seed, robotId: id, tier, alliance }) ?? {
          ...DEFAULT_SPEC,
          name: `${tier} bot`,
          teamName: 'AI',
          teamNumber: 0,
        },
        assists: { ...DEFAULT_ASSISTS },
        startIndex,
      });
    }
  });
  return { setups, botTiers };
}

function cloneMobileLayout(l: GameSettings['mobileLayout']): GameSettings['mobileLayout'] {
  return {
    drive: { ...l.drive },
    turn: { ...l.turn },
    shoot: { ...l.shoot },
    intake: { ...l.intake },
    catalyst: { ...l.catalyst },
    fling: { ...l.fling },
    bbNectar: { ...l.bbNectar },
    scale: l.scale,
  };
}

// ---- PER-GAME loadouts (robot build + saved robots + start positions) ---------

/** the game-specific slice of the settings (what `switchGame` archives + restores) */
function pickLoadout(s: GameSettings): GameLoadout {
  return {
    spec: s.spec,
    savedRobots: s.savedRobots,
    startIndex: s.startIndex,
    startPose: s.startPose ?? null,
    startCat: s.startCat,
    savedStartPoses: s.savedStartPoses,
    startMemory: s.startMemory,
  };
}

/** a fresh loadout for a game: its default robot + empty libraries */
function defaultLoadout(game: GameId): GameLoadout {
  const d = defaultSettings();
  return {
    spec: coerceSpec(DEFAULT_SPEC, DEFAULT_SPEC, game),
    savedRobots: [],
    startIndex: d.startIndex,
    startPose: null,
    startCat: d.startCat,
    savedStartPoses: { close: [], far: [] },
    startMemory: d.startMemory,
  };
}

/** clamp one remembered start SELECTION (a preset index or a custom pose) for `game`.
 * Module-scope because BOTH readers need it — `coerceSettings` for the active game and
 * `coerceLoadout` for an archived one, which used to drop the stored value on the floor. */
function coerceStartSel(raw: unknown, fallback: StartSel, game: GameId): StartSel {
  if (typeof raw !== 'object' || raw === null) return fallback;
  const r = raw as Record<string, unknown>;
  const index = typeof r.index === 'number' && Number.isFinite(r.index)
    ? clamp(Math.round(r.index), -1, startPoseCount(game) - 1)
    : fallback.index;
  const pose = r.pose == null ? null : coerceStartPose(r.pose);
  return { index, pose };
}

/** validate an archived loadout (spec + saved robots clamped for THAT game; start fields
 * light-checked). Written from already-clean data, so this mostly guards a hand-edited store. */
function coerceLoadout(raw: unknown, game: GameId): GameLoadout {
  const d = defaultLoadout(game);
  if (typeof raw !== 'object' || raw === null) return d;
  const r = raw as Record<string, unknown>;
  const saves = (x: unknown): StartPose[] =>
    Array.isArray(x)
      // capped at the SUPPORTER ceiling, never the free one — see the comment on
      // MAX_SAVED_STARTS_SUPPORTER. Slicing to 2 here would delete a paying
      // supporter's saved poses on any load before the entitlement resolves.
      ? x.map((p) => coerceStartPose(p)).filter((p): p is StartPose => p !== null).slice(0, MAX_SAVED_STARTS_SUPPORTER)
      : [];
  const sp = typeof r.savedStartPoses === 'object' && r.savedStartPoses !== null
    ? (r.savedStartPoses as Record<string, unknown>)
    : {};
  return {
    spec: r.spec !== undefined ? coerceSpec(r.spec, DEFAULT_SPEC, game) : d.spec,
    savedRobots: Array.isArray(r.savedRobots)
      ? r.savedRobots.slice(0, MAX_SAVED_ROBOTS).map((x) => coerceSpec(x, undefined, game))
      : d.savedRobots,
    startIndex: typeof r.startIndex === 'number' && Number.isFinite(r.startIndex)
      ? clamp(Math.round(r.startIndex), 0, startPoseCount(game) - 1)
      : d.startIndex,
    startPose: r.startPose == null ? null : coerceStartPose(r.startPose),
    startCat: r.startCat === 'far' ? 'far' : 'close',
    savedStartPoses: { close: saves(sp.close), far: saves(sp.far) },
    // the STORED memory, coerced — not the default. Returning `d.startMemory` here threw the
    // archived game's remembered start away on every load: switch to it and its close/far
    // picks were back at anchors 0 and 1, whatever the player had left them on.
    startMemory: (() => {
      const m = typeof r.startMemory === 'object' && r.startMemory !== null
        ? (r.startMemory as Record<string, unknown>)
        : {};
      return {
        close: coerceStartSel(m.close, d.startMemory.close, game),
        far: coerceStartSel(m.far, d.startMemory.far, game),
      };
    })(),
  };
}

/** switch the ACTIVE game, swapping the flat robot/start fields to that game's OWN copy
 * (archiving the game we're leaving first) so the robot build, saved robots and start
 * positions never bleed across games. Assists ride the restored ROBOT (`spec.assists`), so
 * each game keeps its own drive frame + automation too. */
export function switchGame(s: GameSettings, game: GameId): GameSettings {
  if (game === s.game) return s;
  const loadouts: Partial<Record<GameId, GameLoadout>> = { ...(s.loadouts ?? {}) };
  loadouts[s.game] = pickLoadout(s); // archive the game we're leaving
  const restore = loadouts[game] ?? defaultLoadout(game); // restore the one we enter
  delete loadouts[game]; // it becomes the active (flat) copy, not an archive entry
  return {
    ...s,
    game,
    loadouts,
    ...restore,
    assists: coerceAssists(restore.spec.assists, PLAYER_ASSISTS),
  };
}

type AudioVolume = GameSettings['audio']['volume'];

/** the legacy ON/OFF pair an older client would read, derived from the levels.
 * Seven categories can't map onto two switches exactly — `sounds` mirrors the old
 * master switch (is ANY audio audible) and `voice` the old voice-lines toggle. */
function audioMirrors(av: AudioVolume): { sounds: boolean; voice: boolean } {
  const anyEffect =
    av.game > 0 || av.shoot > 0 || av.intake > 0 || av.gate > 0 || av.beep > 0 || av.alert > 0;
  return {
    sounds: av.master > 0 && (anyEffect || av.voice > 0),
    voice: av.master > 0 && av.voice > 0,
  };
}

/** Re-derive the legacy mirrors after a settings EDIT. `coerceSettings` does this
 * on every load, but a slider drag writes the live object straight to localStorage
 * and the account without passing through coerce — so App's `update()` (the one
 * choke point feeding both) runs this to keep the persisted blob consistent for
 * old clients. Returns `s` unchanged when the mirrors already agree. */
export function syncAudioMirrors(s: GameSettings): GameSettings {
  const m = audioMirrors(s.audio.volume);
  if (s.audio.sounds === m.sounds && s.audio.voice === m.voice) return s;
  return { ...s, audio: { ...s.audio, ...m } };
}

/** validate an arbitrary settings object field by field — anything stale,
 * missing, or corrupt falls back to its default. Shared by the localStorage
 * load and the per-account (server) load, so both paths sanitize identically. */
export function coerceSettings(raw: unknown): GameSettings {
  const out = defaultSettings();
  try {
    if (typeof raw !== 'object' || raw === null) return out;
    const s = raw as Record<string, unknown>;
    if (isGameId(s.game)) out.game = s.game;
    if (s.mode === 'match' || s.mode === 'free') out.mode = s.mode;
    if (s.alliance === 'red' || s.alliance === 'blue') out.alliance = s.alliance;
    // assists + spec share ONE validation path with the server (coerceAssists /
    // coerceSpec in sim/spawn): a hand-edited localStorage spec is clamped to the
    // same legal ranges as a spoofed wire spec, so both surfaces agree exactly.
    // Spec is coerced FIRST because its drivetrain decides the active-assist fallback.
    if (s.spec !== undefined) out.spec = coerceSpec(s.spec, out.spec, out.game);
    // ASSISTS RIDE THE ROBOT. `spec.assists` (already coerced above, defaulting all-ON) is
    // the stored preference; the flat `assists` is just its ACTIVE mirror, so the two can
    // never drift.
    //
    // MIGRATION off the old model: pre-assists-on-spec saves kept the choice in the flat
    // `assists` (and a per-drivetrain library that is now gone). If the stored spec carried
    // no assists of its own, adopt that flat value onto the robot so an existing player's
    // settings survive; only a save with neither falls back to all-ON.
    const specAssists = (s.spec as { assists?: unknown } | undefined)?.assists;
    if (specAssists === undefined && s.assists !== undefined) {
      out.spec = { ...out.spec, assists: coerceAssists(s.assists, PLAYER_ASSISTS) };
    }
    out.assists = coerceAssists(out.spec.assists, PLAYER_ASSISTS);
    // saved libraries: validate each entry through the same coercers, cap the count
    if (Array.isArray(s.savedRobots)) {
      out.savedRobots = s.savedRobots.slice(0, MAX_SAVED_ROBOTS).map((r) => coerceSpec(r, undefined, out.game));
    }
    // `savedAutos` (the `.pp` library) is NOT read back: that import is gone (owner, 2026-09-25),
    // so a stored library is dropped here and never reaches a world. Autos are Zenith files now
    // (`src/auto/library.ts`, device-local).
    if (typeof s.startIndex === 'number') {
      out.startIndex = clamp(Math.round(s.startIndex), 0, startPoseCount(out.game) - 1);
    }
    // custom start pose: structural + field-bounds only here (G304 legality is
    // enforced spec+alliance-aware at spawn via coerceSetup). null ⇒ use preset.
    if ('startPose' in s) out.startPose = s.startPose == null ? null : coerceStartPose(s.startPose);
    if (s.startCat === 'close' || s.startCat === 'far') out.startCat = s.startCat;
    // saved start-position library: coerce each pose, cap per category
    const coerceSaves = (raw: unknown): StartPose[] =>
      Array.isArray(raw)
        ? raw.map((p) => coerceStartPose(p)).filter((p): p is StartPose => p !== null).slice(0, MAX_SAVED_STARTS_SUPPORTER)
        : [];
    if (typeof s.savedStartPoses === 'object' && s.savedStartPoses !== null) {
      const sp = s.savedStartPoses as Record<string, unknown>;
      out.savedStartPoses = { close: coerceSaves(sp.close), far: coerceSaves(sp.far) };
    }
    // per-category memory: clamp index, coerce pose (see `coerceStartSel`)
    if (typeof s.startMemory === 'object' && s.startMemory !== null) {
      const m = s.startMemory as Record<string, unknown>;
      out.startMemory = {
        close: coerceStartSel(m.close, out.startMemory.close, out.game),
        far: coerceStartSel(m.far, out.startMemory.far, out.game),
      };
    }
    // the NON-active games' archived loadouts (robot + saved robots + start positions), so a
    // game switch restores that game's own build/library. The active game lives in the flat
    // fields above and is never kept in the archive.
    if (typeof s.loadouts === 'object' && s.loadouts !== null) {
      const lo = s.loadouts as Record<string, unknown>;
      const archive: Partial<Record<GameId, GameLoadout>> = {};
      for (const g of GAME_IDS) {
        if (g !== out.game && lo[g] !== undefined) archive[g] = coerceLoadout(lo[g], g);
      }
      out.loadouts = archive;
    }
    if (typeof s.practiceDummies === 'boolean') out.practiceDummies = s.practiceDummies;
    if (s.practicePhysics === '2d' || s.practicePhysics === '3d') out.practicePhysics = s.practicePhysics;
    /**
     * THE BOT TIER IS COERCED BY THE GAME THAT HAS ONE — and PRESERVED by the game that does not.
     *
     * `tiers` is opaque on the seam so a game can rename a difficulty without a shared edit, so
     * the only honest validation is the active module's own `coerceTier`, which also answers for
     * a tier that was legal when it was saved and is not any more.
     *
     * ⚠️ **A GAME WITH NO DRIVER MUST NOT FOLD IT TO `'off'`.** Measured in a browser: set
     * Opponents to Hard in BIOBUZZ, visit DECODE (which has no AI), come back — and the setting
     * was gone, because every load coerces against the ACTIVE game and DECODE's answer for any
     * tier is "there is no such thing". `switchGame` deliberately does not archive this field
     * per game (it is a practice preference, not part of a loadout), so the round trip has to be
     * lossless. Keeping the string costs nothing: it is unreachable while the active game has no
     * driver, and the two places that USE it — `GameController.makeWorld` and the Practice
     * control — resolve it through that game's own `coerceTier` at the point of use, which is
     * where the question can actually be answered.
     *
     * Bounded rather than trusted: this is localStorage and a synced account blob, so a
     * megabyte of junk must not ride in a field nothing will ever read.
     */
    if (typeof s.practiceBots === 'string' && s.practiceBots.length <= 32) {
      const bot = simModuleFor(out.game).bot;
      out.practiceBots = s.practiceBots === 'off' || !bot ? s.practiceBots : bot.coerceTier(s.practiceBots);
    }
    // PRACTICE SEATS, entry by entry: an unknown game id is dropped, a game's entry is exactly
    // three seats or it is dropped whole, and a tier is bounded but kept VERBATIM — the same
    // reasoning as `practiceBots` above, resolved by the game's own `coerceTier` at use.
    if (typeof s.practiceSeats === 'object' && s.practiceSeats !== null) {
      const ps = s.practiceSeats as Record<string, unknown>;
      const seats: Partial<Record<GameId, PracticeSeats>> = {};
      for (const g of GAME_IDS) {
        const list = ps[g];
        if (!Array.isArray(list) || list.length !== 3) continue;
        const clean = list.map(coercePracticeSeat);
        if (clean.every((x): x is PracticeSeat => x !== null)) seats[g] = clean as PracticeSeats;
      }
      out.practiceSeats = seats;
    }
    if (typeof s.audio === 'object' && s.audio !== null) {
      const au = s.audio as Record<string, unknown>;
      const vol = au.volume;
      if (typeof vol === 'object' && vol !== null) {
        const v = vol as Record<string, unknown>;
        // MIGRATION: `sfx` was one level behind a slider labelled "Beeping" that
        // actually drove the shooter, the intake, the gate AND the countdown beep.
        // Seed all four from it FIRST, so a player who had turned it down keeps that
        // choice, then let any explicit new key override.
        const legacy = v.sfx;
        if (typeof legacy === 'number' && Number.isFinite(legacy)) {
          const n = clamp(legacy, 0, 1);
          out.audio.volume.shoot = n;
          out.audio.volume.intake = n;
          out.audio.volume.gate = n;
          out.audio.volume.beep = n;
        }
        for (const k of ['master', 'game', 'shoot', 'intake', 'gate', 'beep', 'alert', 'voice'] as const) {
          const n = v[k];
          if (typeof n === 'number' && Number.isFinite(n)) out.audio.volume[k] = clamp(n, 0, 1);
        }
      } else {
        // LEGACY boolean-only shape: a pre-slider save, or a blob that round-tripped
        // through an old client (which drops `volume` when it saves). Map the two
        // switches onto levels so nobody's deliberate mute comes back un-muted.
        if (au.sounds === false) out.audio.volume.master = 0;
        if (au.voice === false) out.audio.volume.voice = 0;
      }
    }
    // re-derive the legacy mirrors from the levels every time, so they can never
    // drift from the sliders (see the `audio` type for why they still exist)
    Object.assign(out.audio, audioMirrors(out.audio.volume));
    if (typeof s.showEventLog === 'boolean') out.showEventLog = s.showEventLog;
    /**
     * THE PERFORMANCE READ-OUT'S LEVEL, and the one migration it needs.
     *
     * An absent value takes the default (`simple`), which is what every settings blob written
     * before this field existed carries — and that is the intended outcome, not an accident of
     * the coercer: the owner asked for fps + ping to be on out of the box, so a returning
     * player gets it on the same terms as a new one.
     *
     * `true`/`false` are accepted because the read-out's ancestors were switches — the
     * `?perf=1` line and the 3D-only Graphics overlay — and anything that round-trips a
     * boolean through this field means "on" rather than "reset me".
     */
    if (PERF_DISPLAY_LEVELS.includes(s.perfDisplay as PerfDisplay)) {
      out.perfDisplay = s.perfDisplay as PerfDisplay;
    } else if (typeof s.perfDisplay === 'boolean') {
      out.perfDisplay = s.perfDisplay ? 'simple' : 'off';
    }
    if (typeof s.parkSpeedPct === 'number') {
      out.parkSpeedPct = clamp(Math.round(s.parkSpeedPct), 0, 100);
    }
    if (typeof s.preferredServerId === 'string') {
      out.preferredServerId = s.preferredServerId;
    }
    if (s.tankControlMode === 'traditional' || s.tankControlMode === 'normal') {
      out.tankControlMode = s.tankControlMode;
    }
    if (typeof s.mobileLayout === 'object' && s.mobileLayout !== null) {
      const ml = s.mobileLayout as Record<string, unknown>;
      const pos = (raw: unknown, def: { x: number; y: number }): { x: number; y: number } => {
        if (typeof raw !== 'object' || raw === null) return { ...def };
        const p = raw as Record<string, unknown>;
        return {
          x: typeof p.x === 'number' ? clamp(p.x, 0, 1) : def.x,
          y: typeof p.y === 'number' ? clamp(p.y, 0, 1) : def.y,
        };
      };
      out.mobileLayout = {
        drive: pos(ml.drive, DEFAULT_MOBILE_LAYOUT.drive),
        turn: pos(ml.turn, DEFAULT_MOBILE_LAYOUT.turn),
        shoot: pos(ml.shoot, DEFAULT_MOBILE_LAYOUT.shoot),
        intake: pos(ml.intake, DEFAULT_MOBILE_LAYOUT.intake),
        catalyst: pos(ml.catalyst, DEFAULT_MOBILE_LAYOUT.catalyst),
        // absent in layouts saved before the throw had its own button — defaulted, not dropped
        fling: pos(ml.fling, DEFAULT_MOBILE_LAYOUT.fling),
        // absent in every layout saved before BIOBUZZ had a human-player button — defaulted,
        // not dropped, the same treatment `fling` got for the same reason
        bbNectar: pos(ml.bbNectar, DEFAULT_MOBILE_LAYOUT.bbNectar),
        scale: typeof ml.scale === 'number' ? clamp(ml.scale, 0.7, 1.5) : 1,
      };
    }
    out.bindings = mergeBindings(s.bindings);

    // `autoPath` / `autoPathEnabled` are not read back either (see `savedAutos` above): the
    // defaults stand, no path and off.

  } catch {
    /* corrupt data — defaults */
  }
  return out;
}

/** load persisted settings from localStorage (validated field by field) */
export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSettings();
    return coerceSettings(JSON.parse(raw));
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(s: GameSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* storage full or unavailable — settings just won't persist */
  }
}