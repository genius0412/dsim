import { useEffect, useMemo, useRef, useState } from 'react';
import type { GameSettings, RobotSpec } from '../types';
import { START_POSES } from '../config';
import { CHAIN_START_POSES } from '../games/chain/config';
import { StartPositionEditor } from './StartPositionEditor';
import { savedStartCap } from './startPositions';
import { useAds } from '../ads/AdsProvider';
import { ChainStartEditor } from './ChainStartEditor';
import { selectStart, switchCategory, saveStart, deleteSavedStart, indexCategory, startSelectionLegal } from './startPositions';
import { useRoleSwap, useDismissable } from './useRoleSwap';
import { RoleSwapBar } from './RoleSwapBar';
import { SupporterBadge } from './SupporterBadge';
import { BadgeMarks } from './BadgeMark';
import type { LobbyClient } from '../net/lobbyClient';
import type { LobbyPlayer, PlayerIntro, QueueMode } from '../net/protocol';
import { RobotPreview } from './RobotPreview';
import { ChainRobotPreview } from '../games/chain/RobotPreview';
import { moduleFor } from '../games';
import { buildSummary, teamLine } from './robotLabels';
import { RobotCard } from './RobotCard';
import { Menu } from './Menu';
import { MatchAudio } from '../audio';
import { ConsoleHead } from './ConsoleHead';

/** beep once per second over the final STRAT_TICK_FROM seconds of the strategy
 * deadline, rising in pitch as it nears (like a match countdown). */
const STRAT_TICK_FROM = 5;

interface Props {
  lobby: LobbyClient;
  players: LobbyPlayer[];
  myClientId: string;
  deadline: number; // epoch ms — match cancels if not everyone's ready by then
  mode: QueueMode;
  intros: PlayerIntro[];
  settings: GameSettings;
  onSettingsChange: (s: GameSettings) => void;
  onLeave: () => void;
  /**
   * IS THERE A RATING ON THIS — the difference between the two windows that open this screen.
   *
   * `true` (the default, and every use of this screen before 2026-09-22) is the RANKED
   * pre-match window: paired strangers, ELO on every card, a re-pick, and a strict ready gate
   * whose clock cancels the match.
   *
   * `false` is a CUSTOM room's 3D-readiness window (`Room.enterCustomStart`). The host has
   * already pressed START and everyone had already readied, so there is nothing to decide
   * here — it is the alliances and what they are waiting for, and no more. The ELO column is
   * gone because there is no ELO, not because it is hidden: a custom room has never rated
   * anything, and a chip reading "ELO Unranked" beside every name would be four lies.
   */
  ranked?: boolean;
}

/**
 * Ranked PRE-MATCH strategy window. Paired strangers (especially a 2v2 alliance)
 * finally see each other before the match: their OWN alliance's builds in full, the
 * opponents as minimal name/team/ELO cards (the server redacts opponent specs so no
 * one can counter-pick), a close/far start-pose claim so partners don't stack, and a
 * strict ready gate. Re-pick is allowed here — a driver can swap a saved robot or open
 * the full builder; the server takes the live build at match start (still clamped to
 * the build limits). The match starts the instant everyone readies; if the deadline
 * passes with anyone not ready the server cancels (arrives as an `error` → onLeave).
 *
 * NO `useEscape` here, unlike the other console screens: `onLeave` forfeits a paired
 * ranked match for everyone in the room, so it stays a deliberate click on ← Leave.
 */
export function MatchStrategy({
  lobby,
  players,
  myClientId,
  deadline,
  mode,
  intros,
  settings,
  onSettingsChange,
  onLeave,
  ranked = true,
}: Props) {
  const [now, setNow] = useState(() => Date.now());
  const [building, setBuilding] = useState(false);

  useEffect(() => {
    const iv = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(iv);
  }, []);

  const me = players.find((p) => p.clientId === myClientId) ?? null;
  const myAlliance = me?.alliance;
  const mates = useMemo(
    () => players.filter((p) => p.alliance === myAlliance && p.clientId !== myClientId && !p.hidden),
    [players, myAlliance, myClientId],
  );
  const opponents = useMemo(
    () => players.filter((p) => p.hidden || (myAlliance && p.alliance !== myAlliance)),
    [players, myAlliance],
  );

  // the chip's whole label: "Rating", never "ELO", in anything a player reads (the system is Glicko-2)
  const ratingChip = (p: LobbyPlayer): string => {
    const e = p.slot !== undefined ? intros.find((i) => i.id === p.slot)?.elo : null;
    return e === null || e === undefined ? 'Unranked' : `Rating ${Math.round(e)}`;
  };

  const secsLeft = Math.max(0, Math.ceil((deadline - now) / 1000));

  /**
   * WHO IS STILL LOADING THE 3D PHYSICS (`LobbyPlayer.ready3d`, server-authored).
   *
   * ABSENT means there is nothing to wait for — a 2D season, a seat on an older build, a
   * server that predates the handshake — so only an explicit `false` counts. Treating absent
   * as "not loaded" would put a permanent loading chip on every DECODE lobby.
   */
  const loading3d = players.filter((p) => p.ready3d === false);

  // countdown SFX: tick down over the final seconds before the deadline. Own audio
  // instance (the game controller isn't up yet here), gated by the Sounds toggle.
  const audioRef = useRef<MatchAudio | null>(null);
  if (audioRef.current === null) audioRef.current = new MatchAudio();
  audioRef.current.masterVolume = settings.audio.volume.master;
  audioRef.current.gameVolume = settings.audio.volume.game;
  audioRef.current.shootVolume = settings.audio.volume.shoot;
  audioRef.current.intakeVolume = settings.audio.volume.intake;
  audioRef.current.gateVolume = settings.audio.volume.gate;
  audioRef.current.beepVolume = settings.audio.volume.beep;
  audioRef.current.alertVolume = settings.audio.volume.alert;
  audioRef.current.voiceVolume = settings.audio.volume.voice;
  const lastTickRef = useRef(Infinity);
  useEffect(() => {
    const a = audioRef.current;
    // fire once per new second in the danger zone (poll runs at 4 Hz, so guard on a
    // strict decrease so we don't re-beep within the same second). NOT in a custom room's
    // readiness window — its deadline starts the match rather than cancelling it, so a
    // countdown cue would be an alarm about nothing.
    if (ranked && a && secsLeft >= 1 && secsLeft <= STRAT_TICK_FROM && secsLeft < lastTickRef.current) {
      a.beep(700 + (STRAT_TICK_FROM - secsLeft) * 90, secsLeft === 1 ? 0.24 : 0.1, 0.4);
    }
    lastTickRef.current = secsLeft;
  }, [secsLeft, ranked]);

  const readyCount = players.filter((p) => p.ready).length;
  const allReady = players.length > 0 && players.every((p) => p.ready);

  const toggleReady = (): void => lobby.update({ ready: !me?.ready });

  // 2v2 ROLE + consent swap (shared with Lobby via useRoleSwap)
  const rs = useRoleSwap(players, me, (patch) => lobby.update(patch), settings.game, settings.audio.volume);
  const startRole = rs.role;
  const [swapDismissed, dismissSwap] = useDismissable(rs.incoming);
  const sCat: GameSettings = { ...settings, startCat: startRole ?? settings.startCat };
  const applyStart = (patch: Partial<GameSettings>): void => {
    const roster: Record<string, unknown> = {};
    if ('startIndex' in patch) roster.startIndex = patch.startIndex;
    if ('startPose' in patch) roster.startPose = patch.startPose ?? null;
    if (Object.keys(roster).length) lobby.update(roster);
    const keys: (keyof GameSettings)[] = ['startCat', 'startMemory', 'savedStartPoses'];
    if (keys.some((k) => k in patch)) onSettingsChange({ ...settings, ...patch });
  };

  // A locked ROLE forces its category: if my active start is in the OTHER category,
  // switch it to this role's remembered/default pick so a FAR robot never sits on a
  // CLOSE spot (or vice-versa). See the matching effect in Lobby.
  useEffect(() => {
    if (!startRole || !me) return;
    const activeCat = me.startPose ? settings.startCat : indexCategory(me.startIndex, settings.game);
    if (activeCat !== startRole) applyStart(switchCategory(sCat, startRole));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startRole, me?.startIndex, me?.startPose, settings.startCat]);

  /** re-pick: swap to a saved robot (or any spec) — echoes to the server + persists */
  const pickSpec = (spec: RobotSpec): void => {
    onSettingsChange({ ...settings, spec });
    lobby.update({ spec, assists: settings.assists });
  };

  /** the full builder edits settings.spec live; mirror every change to the server */
  const onBuilderChange = (next: GameSettings): void => {
    onSettingsChange(next);
    lobby.update({ spec: next.spec, assists: next.assists });
  };

  const mySpec = me?.spec ?? settings.spec;
  // the saved-pose cap a game's own start editor is handed (it cannot read the ads context
  // itself). Up here, before the `building` early return, so the hook runs on every render.
  const maxSaved = savedStartCap(useAds().supporter);
  // my start pose must be legal for my (possibly just-swapped) chassis to ready up —
  // DECODE gates on G304, CR on G04 Lab-Area containment (both games now offer free
  // placement, so neither is legal-by-construction any more).
  const startLegal = startSelectionLegal(
    settings.game,
    mySpec,
    myAlliance ?? settings.alliance,
    me?.startPose,
  );

  // full-builder takeover: reuse the My Robot menu, with a Done button back
  if (building) {
    return (
      <div className="ds-console">
        <div className="ds-console-in">
          <ConsoleHead onBack={() => setBuilding(false)} backLabel="← Done" />
          <Menu settings={settings} onChange={onBuilderChange} />
          <div className="ds-actions">
            <button className="ds-cta" onClick={() => setBuilding(false)}>
              DONE
            </button>
          </div>
        </div>
      </div>
    );
  }

  // module UI slots — absent ⇒ the inline DECODE/CR branches below, unchanged
  const Preview = moduleFor(settings.game).Preview;
  const StartEd = moduleFor(settings.game).startEditor;
  const buildRow = (spec: RobotSpec): JSX.Element => (
    <span className="ptm">{buildSummary(spec, settings.game)}</span>
  );

  return (
    <div className="ds-console">
      <div className="ds-console-in">
        <ConsoleHead onBack={onLeave} backLabel="← Leave" />
        <div className="ds-title">
          <h1>
            {ranked ? 'Match strategy' : 'Starting the match'}
          </h1>
        {/* the sub sits INSIDE `.ds-title`, the title's caption (see `ConsoleHead`). The
            countdown chip's tooltip is gone —
            the `.ds-hint` at the foot of this screen states the same rule at length.

            NO CLOCK IN A CUSTOM ROOM'S WINDOW: its deadline starts the match instead of
            cancelling it, so a ticking chip would promise a consequence that never comes. */}
        <p className="ds-sub ds-sub-row">
          <span>
            {mode.toUpperCase()} ·{' '}
            {ranked ? `${readyCount}/${players.length} ready` : `${players.length} drivers`}
          </span>
          {ranked && (
            <span className={`ds-chip ${secsLeft <= STRAT_TICK_FROM ? 'off' : 'on'}`}>
              ⏱ {secsLeft}s
            </span>
          )}
        </p>
        </div>

        {/* opponents — minimal (server redacts their builds) */}
        {opponents.length > 0 && (
          <section className="ds-sec">
            <h2>{opponents.length > 1 ? 'Opponents' : 'Opponent'}</h2>
            <div className="ds-players">
              {opponents.map((p) => (
                <div key={p.clientId} className={`ds-player ${p.alliance}`}>
                  <span className="pdot" />
                  {/* the roster composition the lobby uses, because this IS the lobby roster
                      for a ranked room — the reveal named an opponent with no badge and no
                      title while the same person's row in a custom room carried both. */}
                  <span className="pnm">
                    {p.name}
                    <SupporterBadge supporter={p.supporter} role={p.role} />
                    <BadgeMarks badges={p.badges} />
                  </span>
                  <span className="ptm">Team {p.teamNumber || '-'}</span>
                  <span className={`ds-chip ${p.alliance}`}>{p.alliance.toUpperCase()}</span>
                  {ranked && <span className="ds-chip">{ratingChip(p)}</span>}
                  {p.ready3d === false && <span className="ds-chip off">LOADING 3D</span>}
                  <span className={`ds-chip ${p.ready ? 'on' : 'off'}`}>
                    {p.ready ? 'READY' : '…'}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* your alliance — full build reveal */}
        <section className="ds-sec">
          <h2>Your alliance</h2>
          <div className="ds-strat-cards">
            {[me, ...mates].filter(Boolean).map((p) => {
              const pl = p as LobbyPlayer;
              const isMe = pl.clientId === myClientId;
              const spec = isMe ? mySpec : pl.spec;
              return (
                <div key={pl.clientId} className={`ds-strat-card ${pl.alliance}`}>
                  <div className="ds-strat-prev">
                    {Preview ? (
                      <Preview spec={spec} size={132} />
                    ) : settings.game === 'chain' ? (
                      <ChainRobotPreview spec={spec} size={132} />
                    ) : (
                      <RobotPreview spec={spec} size={132} />
                    )}
                  </div>
                  <div className="ds-strat-meta">
                    <span className="pnm">
                      {pl.name}
                      {isMe ? ' (you)' : ''}
                      <SupporterBadge supporter={pl.supporter} role={pl.role} />
                      <BadgeMarks badges={pl.badges} />
                    </span>
                    <span className="ptm">
                      {spec.name} · Team {pl.teamNumber || '-'}
                    </span>
                    {buildRow(spec)}
                    <div className="ds-strat-chips">
                      <span className={`ds-chip ${pl.alliance}`}>{pl.alliance.toUpperCase()}</span>
                      {pl.ready3d === false && <span className="ds-chip off">LOADING 3D</span>}
                      <span className="ds-chip">
                        {pl.startPose
                          ? 'CUSTOM'
                          : settings.game === 'chain'
                            ? (CHAIN_START_POSES[pl.startIndex]?.name ?? '-')
                            : (moduleFor(settings.game).startAnchorName?.(pl.startIndex, pl.alliance) ??
                              START_POSES[pl.startIndex]?.label ??
                              '-')}
                      </span>
                      {ranked && <span className="ds-chip">{ratingChip(pl)}</span>}
                      <span className={`ds-chip ${pl.ready ? 'on' : 'off'}`}>
                        {pl.ready ? 'READY' : 'NOT READY'}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* start position — drag to place, constrained to a legal G304 setup.
            RANKED ONLY: a custom room's window opens AFTER its host pressed START, so a
            re-pick offered here would be a control that changes a match already committed. */}
        {ranked && me && (
          <section className="ds-sec">
            <h2>Start position</h2>
            {rs.canSwap && (
              <RoleSwapBar
                role={startRole}
                partnerName={rs.partner?.name ?? 'Partner'}
                rs={rs}
                dismissed={swapDismissed}
                onDismiss={dismissSwap}
                game={settings.game}
                alliance={me.alliance}
              />
            )}
            {StartEd ? (
              <StartEd
                maxSaved={maxSaved}
                spec={me.spec}
                alliance={me.alliance}
                value={me.startPose}
                startIndex={me.startIndex ?? 0}
                category={startRole ?? settings.startCat}
                saved={settings.savedStartPoses}
                lockedCategory={startRole}
                onChange={(startPose) => startPose && applyStart(selectStart(sCat, { index: -1, pose: startPose }))}
                onPickPreset={(i) => applyStart(selectStart(sCat, { index: i, pose: null }))}
                onCategory={(c) => applyStart(switchCategory(settings, c))}
                onSave={(pose) => applyStart(saveStart(sCat, pose))}
                onDeleteSaved={(c, i) => applyStart(deleteSavedStart(sCat, c, i))}
              />
            ) : settings.game === 'chain' ? (
              <ChainStartEditor
                spec={me.spec}
                alliance={me.alliance}
                value={me.startPose}
                startIndex={me.startIndex ?? 0}
                category={startRole ?? settings.startCat}
                saved={settings.savedStartPoses}
                lockedCategory={startRole}
                onChange={(startPose) => applyStart(selectStart(sCat, { index: -1, pose: startPose }))}
                onPickPreset={(i) => applyStart(selectStart(sCat, { index: i, pose: null }))}
                onCategory={(c) => applyStart(switchCategory(settings, c))}
                onSave={(pose) => applyStart(saveStart(sCat, pose))}
                onDeleteSaved={(c, i) => applyStart(deleteSavedStart(sCat, c, i))}
              />
            ) : (
              <StartPositionEditor
                spec={me.spec}
                alliance={me.alliance}
                value={me.startPose}
                startIndex={me.startIndex}
                category={startRole ?? settings.startCat}
                saved={settings.savedStartPoses}
                lockedCategory={startRole}
                onChange={(startPose) => startPose && applyStart(selectStart(sCat, { index: -1, pose: startPose }))}
                onPickPreset={(i) => applyStart(selectStart(sCat, { index: i, pose: null }))}
                onCategory={(c) => applyStart(switchCategory(settings, c))}
                onSave={(pose) => applyStart(saveStart(sCat, pose))}
                onDeleteSaved={(c, i) => applyStart(deleteSavedStart(sCat, c, i))}
              />
            )}
          </section>
        )}

        {/* re-pick: quick-swap a saved robot, or open the full builder (ranked only — see
            the start-position section above) */}
        {ranked && (
        <section className="ds-sec">
          <h2>Your robot</h2>
          <div className="ds-opts robots">
            {settings.savedRobots.map((r, i) => {
              const active =
                r.length === mySpec.length &&
                r.width === mySpec.width &&
                r.intake === mySpec.intake &&
                r.drivetrain === mySpec.drivetrain &&
                r.driveRpm === mySpec.driveRpm &&
                r.massLb === mySpec.massLb;
              // the builder's own card (`RobotCard`), so a saved robot reads the same here as
              // it does in Configure and in the custom-room lobby
              return (
                <RobotCard
                  key={i}
                  spec={r}
                  game={settings.game}
                  on={active}
                  team={teamLine(r)}
                  onPick={() => pickSpec({ ...r })}
                />
              );
            })}
            <button className="ds-opt mini" onClick={() => setBuilding(true)}>
              <span className="ot">Edit build</span>
            </button>
          </div>
        </section>
        )}

        {ranked && (
          <div className="ds-actions">
            <button
              className={`ds-cta ${me?.ready ? 'secondary' : ''}`}
              disabled={!startLegal && !me?.ready}
              onClick={toggleReady}
            >
              {me?.ready ? '✓ READY' : 'READY UP'}
            </button>
          </div>
        )}
        {/* ⚠️ THE WAIT OUTRANKS "Everyone ready. Starting…", which is the line this screen used
            to sit on for as long as a chunk took to arrive — a sentence that says the match is
            starting while nothing happens is the report this window was built for. A seat that
            is still loading is named above and said here. */}
        <p className={loading3d.length ? 'ds-loading' : 'ds-hint'}>
          {loading3d.length
            ? 'Loading 3D physics… The match starts as soon as every driver’s field is ready.'
            : !ranked
              ? 'Everyone ready. Starting…'
              : !startLegal
                ? '⚠ Your start position isn’t legal for this chassis. Fix it above, or pick a preset, to ready up.'
                : allReady
                  ? 'Everyone ready. Starting…'
                  : `The match starts when all ${players.length} drivers are ready. It CANCELS if anyone isn’t ready in ${secsLeft}s.`}
        </p>
      </div>
    </div>
  );
}
