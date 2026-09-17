import type { Alliance, Vec2 } from '../../types';
import { dcos, dsin } from '../../math';
import {
  BB_CELL_OPEN,
  BB_HIVE_BOTTOM_Z,
  BB_HIVE_CELL_DY,
  BB_HIVE_LEN,
  BB_HIVE_OPEN_Z,
  BB_HIVE_W,
  BB_HIVE_X,
  BB_TIP_POLLEN,
} from './config';
import type { BbCellSide, BbHiveState, Vec3 } from './state';
import type { BbElementKind } from './flower';

/**
 * HIVE logic — capture, the TIP, the release, the spill (§9.6 Figs 9-7…9-11, §10.5.1), PURE.
 *
 * Each alliance has one HIVE: two CELLS on one rigid bar rocking about a pivot 43.95 in up,
 * bi-stable at ±30°, one CELL up at a time. Elements LAUNCHED into the up-CELL accumulate
 * until the load overcomes the damper; the bar swings, the contents fall out as it passes
 * level, and the other CELL arrives up.
 *
 * Nothing here reads or writes `World`. A HIVE is exactly `BbHiveState` (`state.ts`);
 * functions take one and return a NEW one. The colour lookup belongs to the caller, and so does
 * the RNG — `spillPoses` takes a `() => number` so `play.ts` can hand it the world's mulberry32
 * and a smoke check can hand it a counter.
 */

export type { BbCellSide };

/**
 * A HIVE — now exactly `BbHiveState`, and this is a RE-EXPORT rather than an interface.
 *
 * It used to widen the state's shape with an optional `released`, because the spill and the
 * TIP happen at DIFFERENT moments of one swing (see `hiveStep`) and `state.ts` did not carry
 * the latch that tells a bar still holding its load from one that has already emptied. The
 * field landed at the wiring pass, so the widening is gone: there is ONE hive shape, the
 * state's, and a hive read off `world.biobuzz` and a hive this module returns are the same
 * type. The alias stays so every existing caller and check keeps its name.
 */
export type HiveState = BbHiveState;

/**
 * Duration of the swing from one stable state to the other, seconds.
 *
 * RULING (field-plan §2.1, 2026-09-12): **4.0**. A 43.95-in bar carrying a dozen elements is a
 * slow, damped see-saw, not a trigger. Not APPROX: it is a decision, not a measurement.
 *
 * It is gameplay-load-bearing because of what the swing does to the TARGET, which is no longer
 * "the cell takes nothing for four seconds" (owner feedback, 2026-09-12): the tray keeps taking
 * throughout, and the release HANDS OVER from the filled tray to the incoming one half way
 * through (`hiveTakingSide`). What the length costs a launcher is the two seconds in which its
 * own opening is the one about to empty, and the aim change at the hand-over.
 */
export const BB_TIP_SWING_S = 4.0;

/**
 * When in the swing the contents fall out, in seconds REMAINING.
 *
 * RULING (field-plan §2.1): at LEVEL, i.e. half way. The CELL is a tray with an open outer
 * end; it holds while it is tilted back and empties the instant the floor passes horizontal,
 * which is the midpoint of a ±30° rock. Taking that as `SWING / 2` assumes a constant angular
 * rate, which a damped swing is not exactly — the error is at most a few tenths and moves only
 * WHEN the spill lands on the tiles, never whether it does.
 */
export const BB_TIP_RELEASE_S = BB_TIP_SWING_S / 2;

/** how far ABOVE the opening's top a descending element is still taken as entering — the
 * opening is 14 in tall (§9.6.2) and a lob arrives from above. APPROX. */
export const BB_HIVE_ACCEPT_MARGIN = 2.0; // APPROX

/** what is in an up-CELL, counted by type — the two numbers `BB_TIP_POLLEN` is indexed by. */
export interface HiveLoad {
  pollen: number;
  nectar: number;
}

export function otherSide(side: BbCellSide): BbCellSide {
  return side === 'north' ? 'south' : 'north';
}

/** the HIVE's pivot on the tiles — red x = −BB_HIVE_X, blue +BB_HIVE_X, both on y = 0 (Fig 9-10). */
export function hivePivot(alliance: Alliance): Vec2 {
  return { x: alliance === 'red' ? -BB_HIVE_X : BB_HIVE_X, y: 0 };
}

/** horizontal centre of one CELL's opening: the pivot displaced along y by the tilted arm's
 * projection (`BB_HIVE_CELL_DY`, reference §2.2). */
export function hiveCellPos(alliance: Alliance, side: BbCellSide): Vec2 {
  const p = hivePivot(alliance);
  return { x: p.x, y: p.y + (side === 'north' ? BB_HIVE_CELL_DY : -BB_HIVE_CELL_DY) };
}

/**
 * Which way along the HIVE axis an element must be TRAVELLING to get into the up-CELL: toward
 * the pivot, i.e. INBOARD.
 *
 * RULING (field-plan §2.1): the CELL is open at its OUTER end only. The up-cell's outer end is
 * its high end, so the only way in is a shot arriving over that lip and running down the tray
 * toward the pivot. A shot crossing the same rectangle outbound is going the other way through
 * the closed back wall, which is a bounce off the structure, not a capture (G417.H: a miss is
 * not a foul). `+1` means +y.
 */
export function hiveApproachSign(up: BbCellSide): 1 | -1 {
  return up === 'north' ? -1 : 1;
}

/**
 * WHICH CELL IS TAKING ELEMENTS RIGHT NOW — the ONE answer, and every capture, park, aim and
 * readout has to come through it.
 *
 * Settled, it is `up`, as it always was. THROUGH A SWING IT FOLLOWS THE RELEASE (owner
 * feedback, 2026-09-12):
 *
 *  • BEFORE the bar passes level (`released` false) it is still `up` — the tray that just
 *    filled. It is tilted back, it is holding its load, and a shot already in the air when the
 *    swing started arrives at a cell that is still a cell. Refusing those was the old
 *    behaviour, and the thing it produced was a driver watching a volley he had already fired
 *    pass through the tray and land on the tiles.
 *  • AFTER the release it is `otherSide(up)` — the tray coming UP, now empty, whose opening is
 *    rising into the launch window. (Aim Assist does not know any of this — it aims at the
 *    nearer own cell as if it were up, `play.ts` `bbAimTarget` — but a shot that reaches the
 *    rising tray after the release still goes in.)
 *
 * So the HIVE is never a hole in the field; the only thing a swing changes is WHICH tray your
 * element lands in, and the handover is the same instant as the spill. `hiveStep` carries a
 * post-release load through the settle for exactly this reason.
 */
export function hiveTakingSide(hive: HiveState): BbCellSide {
  return hive.tipping > 0 && hive.released ? otherSide(hive.up) : hive.up;
}

/**
 * CAPTURE test for one flight element: inside the TAKING cell's accept footprint
 * (`BB_CELL_OPEN`, centred on `hiveTakingSide`), at opening height (`BB_HIVE_OPEN_Z`, plus
 * `margin` above), DESCENDING, and travelling INBOARD along the HIVE axis
 * (`hiveApproachSign`).
 *
 * MID-SWING IT STILL ACCEPTS, into whichever tray `hiveTakingSide` names — see that function
 * for which one and why. The opening is genuinely moving through the swing and this test does
 * not model that: it uses the taking cell's SETTLED footprint throughout. That is the honest
 * trade. The alternative the code had was refusing everything for four seconds, and a cell
 * that is 10.43 in deep in plan sweeps most of its own footprint anyway.
 */
export function hiveAccepts(
  hive: HiveState,
  alliance: Alliance,
  pos: Vec2,
  z: number,
  vel: Vec3,
  margin: number = BB_HIVE_ACCEPT_MARGIN,
): boolean {
  if (vel.z >= 0) return false;
  const side = hiveTakingSide(hive);
  if (vel.y * hiveApproachSign(side) <= 0) return false;
  const c = hiveCellPos(alliance, side);
  if (Math.abs(pos.x - c.x) > BB_CELL_OPEN.w / 2 || Math.abs(pos.y - c.y) > BB_CELL_OPEN.d / 2) return false;
  return z >= BB_HIVE_OPEN_Z[0] && z <= BB_HIVE_OPEN_Z[1] + margin;
}

/** what is in the cell, by type. */
export function hiveLoad(contents: readonly number[], kindOf: (id: number) => BbElementKind): HiveLoad {
  let pollen = 0;
  let nectar = 0;
  for (const id of contents) {
    if (kindOf(id) === 'pollen') pollen++;
    else nectar++;
  }
  return { pollen, nectar };
}

/**
 * Does this load tip the CELL? `BB_TIP_POLLEN` is a MEASURED TABLE indexed by nectar count
 * (config.ts, owner 2026-09-12) and nothing interpolates it — a see-saw is torque and packing,
 * not weight, and no linear mass model fits the measured rows. Past the end of the table the
 * last row holds, which is 0 pollen: five nectar tip a cell on their own.
 */
export function hiveWillTip(load: HiveLoad): boolean {
  return load.pollen >= BB_TIP_POLLEN[Math.min(load.nectar, BB_TIP_POLLEN.length - 1)];
}

/**
 * HOW MUCH FASTER A HEAVIER TRAY SWINGS (owner feedback, 2026-09-13: "the hive should tip over
 * faster when more balls are in the cell").
 *
 * `BB_TIP_SWING_S` is the swing of a tray loaded to EXACTLY its threshold. Every element over
 * that is torque the damper did not need, and it drives the bar harder — so the countdown runs
 * at `1 + BB_TIP_RATE_PER_EXTRA` per surplus element, capped at `BB_TIP_RATE_MAX`. The surplus
 * is measured against the TIP TABLE, not as a raw count: a cell that tips on 5 NECTAR alone and
 * one that tips on 8 POLLEN are both AT threshold and both swing at the nominal rate, and a
 * NECTAR arriving in a tray that already has three lowers the pollen threshold, which is the
 * table saying it weighs more. Two extras run the 4 s swing in ~2.4 s; the cap is reached at
 * about six, around 1.3 s.
 *
 * The cell goes on taking elements through the first half of the swing (`hiveTakingSide`), so
 * a driver who keeps firing into a tipping tray is speeding it up — that is the mechanic.
 *
 * Both APPROX: a swing rate is a feel ruling with no figure in the manual behind it.
 */
export const BB_TIP_RATE_PER_EXTRA = 0.35; // APPROX
export const BB_TIP_RATE_MAX = 3; // APPROX

/** how many elements a load is OVER its tip threshold — 0 for a tray at or under it. */
export function hiveSurplus(load: HiveLoad): number {
  const row = Math.min(load.nectar, BB_TIP_POLLEN.length - 1);
  const overPollen = load.pollen - BB_TIP_POLLEN[row];
  // past the end of the table the threshold is already 0 pollen, so an extra NECTAR there is
  // surplus in its own right rather than a lower row
  const overNectar = load.nectar - row;
  return Math.max(0, overPollen + overNectar);
}

/** the swing's rate multiplier for this load — 1 at threshold, rising with the surplus. */
export function hiveSwingRate(load: HiveLoad): number {
  return Math.min(BB_TIP_RATE_MAX, 1 + BB_TIP_RATE_PER_EXTRA * hiveSurplus(load));
}

export interface HiveStepResult {
  hive: HiveState;
  /** the swing SETTLED this step — the TIP is complete (§10.5.1 A+B), award the 20 now */
  tipped: boolean;
  /** ids that left the CELL this step, as the bar passed level; empty on every other step */
  spilled: number[];
}

/**
 * One tick of HIVE mechanics. Three distinct moments, and keeping them apart is the point:
 *
 * 1. **Settled and loaded** (`hiveWillTip`) ⇒ the swing STARTS. No points: §10.5.1 scores a
 *    TIP when the damper makes contact, which is the END of the swing.
 * 2. **Mid-swing, passing LEVEL** (`BB_TIP_RELEASE_S` left) ⇒ the contents fall out, returned
 *    as `spilled` for the caller to put back on the tiles (`spillPoses`). `released` latches so
 *    a tray cannot empty twice, and the fallback at settle covers a `dt` longer than half a
 *    swing.
 * 3. **The swing reaching zero** ⇒ the cells swap, `tips` increments, `tipped` is true.
 *
 * ⚠️ `contents` SURVIVES THE SETTLE ONCE THE TRAY HAS RELEASED. The cell goes on taking
 * elements through the swing (`hiveTakingSide`), and after the release the tray filling is the
 * one coming UP — the one that `up` names a tick later. Emptying `contents` unconditionally at
 * the settle threw those away, silently, a second or two after they were captured. So the
 * settle keeps them when `released` is set, and only clears (and spills) when it is not, which
 * is the `dt`-longer-than-half-a-swing fallback and nothing else.
 *
 * The spill therefore lands while the bar is still moving, a couple of seconds before the
 * points — which is what a real HIVE does, and what makes the elements available to a robot
 * under the structure before the score changes. Never mutates `hive`.
 */
export function hiveStep(hive: HiveState, dt: number, kindOf: (id: number) => BbElementKind): HiveStepResult {
  if (hive.tipping > 0) {
    const released = hive.released;
    /**
     * THE RATE (`hiveSwingRate`). BEFORE the release the tray is still loaded and still
     * taking, so the rate is read off what is in it RIGHT NOW — it can only rise, because
     * nothing leaves a tray until level. AFTER the release the load is on the tiles and the
     * bar is coasting on what it was given, so the rate the swing HAD is carried
     * (`swingRate`). A swing from a snapshot that predates the field runs at the nominal rate.
     */
    const rate = released ? (hive.swingRate ?? 1) : hiveSwingRate(hiveLoad(hive.contents, kindOf));
    const left = hive.tipping - dt * rate;
    if (left > 0) {
      const releasing = !released && left <= BB_TIP_RELEASE_S;
      return {
        hive: {
          ...hive,
          contents: releasing ? [] : [...hive.contents],
          tipping: left,
          released: released || releasing,
          swingRate: rate,
        },
        tipped: false,
        spilled: releasing ? [...hive.contents] : [],
      };
    }
    return {
      hive: {
        up: otherSide(hive.up),
        // the load the INCOMING tray took after the release — see the note above. Empty in the
        // ordinary case, because nothing was launched during the second half of the swing.
        contents: released ? [...hive.contents] : [],
        tips: hive.tips + 1,
        tipping: 0,
        released: false,
        // settled: no swing, no rate. Dropped rather than written as 1 so a settled hive is
        // the same JSON it was before the field existed.
      },
      tipped: true,
      // normally empty — the tray emptied at level. Non-empty only when one `dt` spanned the
      // whole second half of the swing, and then the elements still have to go somewhere.
      spilled: released ? [] : [...hive.contents],
    };
  }
  const load = hiveLoad(hive.contents, kindOf);
  if (hiveWillTip(load)) {
    return {
      hive: {
        ...hive,
        contents: [...hive.contents],
        tipping: BB_TIP_SWING_S,
        released: false,
        swingRate: hiveSwingRate(load),
      },
      tipped: false,
      spilled: [],
    };
  }
  return { hive: { ...hive, contents: [...hive.contents] }, tipped: false, spilled: [] };
}

/**
 * How hard a TIP throws its contents, and how wide.
 *
 * ⚠️ **OWNER FEEDBACK, 2026-09-12, FROM PLAYING IT: A TIP IS A DUMP, NOT A CANNON.** The
 * elements should fall out of the tray, run STRAIGHT-ISH outboard, and do their scattering
 * against each other once they are on the tiles — which is what round elements sharing a floor
 * do, and what the shared solve already models. Two numbers moved:
 *
 *  • SPEED **down 30%**, 50-88 → 35-62 in/s. The ruling asked for "about thirty percent less
 *    power" in as many words; the pair is the old one times 0.7, rounded to whole in/s.
 *  • FAN **55° → 18°**. 55° is a ramp firing a shell of elements across a third of a circle,
 *    and it is the half of the old calibration that made a spill read as an explosion. 18° is
 *    a tray emptying downhill with the spread a pile of balls leaving a lip actually has.
 *
 * BOTH STILL APPROX, and MORE approx than the pair they replace: the previous numbers were
 * fitted to the owner's landing lines off the visuals chat's field-v4 page, and these are a
 * ruling about FEEL that moves the landing distance with it (~57-107 in from the pivot before,
 * roughly half that now — the throw is not what puts a spill across the field any more, the
 * roll is). V1 prints no spill kinematics at all, so neither pair was ever a measurement. See
 * `docs/biobuzz/feedback/001-spill-kinematics.md` for the numbers either side of both changes.
 *
 * ⚠️ THE FAN IS AN ANGLE, NOT A CROSS-SPEED. `BB_SPILL_LATERAL` was ±12 in/s added across the
 * throw, so the widest possible fan was `atan(12 / 50)` — the FASTER an element left, the
 * NARROWER its spread, which is backwards: a ramp scatters by direction, and how far a given
 * element goes is then a consequence of its own angle and speed rather than a cap on the width.
 */
export const BB_SPILL_SPEED: readonly [number, number] = [30, 62]; // APPROX
export const BB_SPILL_FAN = 40; // degrees off the outboard axis, half-angle. APPROX

/**
 * THE ALL-DIRECTIONS KICK (owner feedback, 2026-09-13: "the cells when they are released should
 * scatter ball slightly more randomly in all directions").
 *
 * Two changes together. The FAN opened 18° → 40°: a pile leaving a lip does not all go the
 * same way, and at 18° a spill still read as a volley. And each element now gets a KICK — up
 * to `BB_SPILL_KICK` in/s in a direction drawn from the WHOLE circle, added on top of the
 * fanned throw — which is the part the fan cannot express: a fan is symmetric about outboard
 * and every element in it is going outboard at its full drawn speed, so nothing ever dribbles
 * out short or drifts a little inboard of its neighbour. The kick is the tumble of a ball
 * falling 25 in out of a tray onto a pile.
 *
 * SMALL ON PURPOSE, and bounded so every element STILL LEAVES OUTBOARD: the slowest, widest
 * throw is `30 · cos 40° ≈ 23` in/s outboard and the kick is at most 12, so the sign of `vel.y`
 * is never in doubt and the smoke lane keeps asserting it. The speed a pose reports is now
 * `BB_SPILL_SPEED ± BB_SPILL_KICK` and its direction `BB_SPILL_FAN` plus what a 12 in/s kick
 * can turn a ≥30 in/s throw by (`asin(12/30)`, ~24°). APPROX, like the pair above.
 */
export const BB_SPILL_KICK = 12; // in/s, APPROX

/** one spilled element: where it re-enters the world and how fast it is going. */
export interface SpillPose {
  pos: Vec3;
  vel: Vec3;
}

/**
 * Where spilled elements re-enter the world, and with what velocity.
 *
 * `hive` is the hive AS IT IS WHEN THE SPILL HAPPENS — mid-swing, still carrying the `up` of
 * the cell that is on its way down — so the emptying cell is `hive.up` while `tipping > 0`,
 * and `otherSide(hive.up)` once it has settled. Both callers work: `spillPoses` takes the side
 * explicitly through `hive`, reading the emptying side off `tipping`.
 *
 * The elements leave over the cell's open OUTER end, so they land just outboard of the cell
 * centre and are thrown along a direction drawn from the ±`BB_SPILL_FAN` fan about the outboard
 * axis, at a speed drawn from `BB_SPILL_SPEED`. `z` is `BB_HIVE_BOTTOM_Z` — the underside of the
 * structure, the height the tray is at when it empties — and `vel.z` is 0, leaving the drop to
 * the caller's flight step.
 *
 * THE FAN IS APPLIED AS A ROTATION of the outboard unit vector, so the element's SPEED is what
 * `BB_SPILL_SPEED` says whatever direction it took. Building the velocity as "outboard speed
 * plus a cross term" instead makes the drawn speed the outboard COMPONENT, which is a different
 * and larger number, and makes the fan narrow as the speed rises.
 *
 * `rng` yields [0, 1) and is drawn SIX TIMES PER POSE in order (x, y, speed, angle, kick
 * direction, kick magnitude), so a deterministic rng gives a deterministic scatter.
 */
export function spillPoses(hive: HiveState, alliance: Alliance, count: number, rng: () => number): SpillPose[] {
  const emptying = hive.tipping > 0 ? hive.up : otherSide(hive.up);
  const c = hiveCellPos(alliance, emptying);
  const sign = emptying === 'north' ? 1 : -1;
  const cy = c.y + sign * (BB_CELL_OPEN.d / 2);
  const [vMin, vMax] = BB_SPILL_SPEED;
  const out: SpillPose[] = [];
  for (let i = 0; i < count; i++) {
    const x = c.x + (rng() * 2 - 1) * (BB_CELL_OPEN.w / 2);
    const y = cy + (rng() * 2 - 1) * (BB_CELL_OPEN.d / 2);
    const speed = vMin + rng() * (vMax - vMin);
    // the outboard axis is ±y; a fan angle of 0 throws straight out, ±FAN swings it toward ±x.
    // `dsin`/`dcos` take RADIANS — the constant is in DEGREES because that is how the ruling is
    // written and how a fan is read off a drawing.
    const a = (rng() * 2 - 1) * BB_SPILL_FAN * (Math.PI / 180);
    // the kick: any direction on the circle, any magnitude up to `BB_SPILL_KICK`
    const ka = rng() * 2 * Math.PI;
    const kv = rng() * BB_SPILL_KICK;
    out.push({
      pos: { x, y, z: BB_HIVE_BOTTOM_Z },
      vel: { x: speed * dsin(a) + kv * dcos(ka), y: sign * speed * dcos(a) + kv * dsin(ka), z: 0 },
    });
  }
  return out;
}

/**
 * A MISS BOUNCES OFF THE STRUCTURE AND DROPS BESIDE IT (owner feedback, 2026-09-13: "when I
 * shoot and miss at the hive cell, it should bounce off and then fall next to where the cell
 * was").
 *
 * Until now a shot that met the HIVE anywhere but the open mouth of the taking cell "simply
 * kept flying and landed on the tiles" (G417.H says a miss is not a foul, and that was read as
 * a miss being nothing at all) — an element passed through 40 in of steel and landed thirty
 * feet downrange. This gives the assembly a body to hit.
 *
 * THE BODY IS A BOX, APPROX: the assembly's plan footprint (`BB_HIVE_W` × `BB_HIVE_LEN`, centred
 * on the pivot) between the underside of the down cell (`BB_HIVE_BOTTOM_Z`) and the top of the
 * up cell's opening (`BB_HIVE_OPEN_Z[1]`). The real thing is two tilted trays on a bar, and the
 * air under the raised outer lip of the up cell is inside this box — but the sim is top-down,
 * the difference is a few inches of where a miss comes down, and a shot low enough to pass
 * under the lip is one nobody aimed.
 *
 * THE FACES. The two long SIDES, the DOWN cell's outer end and the UNDERSIDE deflect, and so
 * does the PIVOT PLANE inside the box (y = 0, the bar and the up cell's closed back). Two
 * openings are left, on purpose:
 *
 *  • NO TOP. An element coming DOWN into the footprint from above is left alone. The capture
 *    test has already run, so a descent over the taking cell is one it refused (wrong alliance,
 *    or arriving over the closed back) and the honest outcome is that it drops into the tray
 *    and out — i.e. lands, which is what leaving it alone does. And a box with a top is a
 *    surface a ball can COME TO REST ON: each bounce takes some `vz`, the next re-entry takes
 *    more, and an element ends up sitting at 65.6 in for the rest of the match with no way to
 *    the tiles. The underside has no such problem — gravity is on its side.
 *  • THE MOUTH: the TAKING cell's outer end (`hiveTakingSide`) is OPEN at every height. It is
 *    the end the opening is on, and the up tray is raised, so the whole face under its lip is
 *    air — a shot crossing it below the window passes under the tray, and a DUMPER parked at
 *    the lip throws steeply up through that air into the opening (its whole design). Solid,
 *    this face caught every one of those, and Aim Assist's flat lobs with it: they cross the
 *    lip a hair before their apex, still climbing, which `hiveAccepts` refuses for one tick and
 *    the face then refused for good. What such a shot meets if it does NOT rise into the window
 *    is the structure at the pivot — hence the pivot plane, which is what a shot from the closed
 *    side hits too.
 *
 * IT IS AN ENTRY TEST, from `prev` (last tick's position) to `pos` (this tick's): a face was
 * crossed if `prev` was outside the box and `pos` is inside it, and WHICH face is the slab the
 * path crossed LAST (the largest entry parameter). An element that was already inside — one a
 * scene placed there, or one that came in through an opening — is not touched by the faces,
 * which is what keeps this from ever grabbing something it has no face to push it out of; the
 * pivot plane is the one interior surface, and it is a crossing test in its own right.
 *
 * THE BOUNCE IS A DUMP, LIKE THE SPILL: the normal component comes back at `BB_HIVE_MISS_REST`
 * of itself and the tangential one is cut to `BB_HIVE_MISS_TANGENT` — a plastic ball on a
 * steel plate does not ring, and the ruling is that it lands NEXT to the structure, not that it
 * caroms across the field. The element is put back ON the face it hit, a hair outside, with the
 * remainder of its motion this tick discarded. `vz` is untouched by a side hit (the face is
 * vertical) and simply reversed by the underside.
 *
 * Returns the corrected pose, or `null` for "no face was crossed — leave the arc alone". PURE;
 * `play.ts` owns the element it applies this to.
 */
export const BB_HIVE_MISS_REST = 0.3; // APPROX
export const BB_HIVE_MISS_TANGENT = 0.5; // APPROX

/** where a deflected element is after the bounce, and how it is moving */
export interface HiveDeflection {
  pos: Vec3;
  vel: Vec3;
}

export function hiveDeflect(
  hive: HiveState,
  alliance: Alliance,
  prev: Vec3,
  pos: Vec3,
  vel: Vec3,
): HiveDeflection | null {
  const p = hivePivot(alliance);
  const min = { x: p.x - BB_HIVE_W / 2, y: p.y - BB_HIVE_LEN / 2, z: BB_HIVE_BOTTOM_Z };
  const max = { x: p.x + BB_HIVE_W / 2, y: p.y + BB_HIVE_LEN / 2, z: BB_HIVE_OPEN_Z[1] };
  const inside = (q: Vec3): boolean =>
    q.x >= min.x && q.x <= max.x && q.y >= min.y && q.y <= max.y && q.z >= min.z && q.z <= max.z;
  if (!inside(pos)) return null;
  // a hair outside a face, so next tick's `inside(prev)` reads false and the element cannot
  // be caught twice on one contact
  const EPS = 0.01;
  // the mouth's sign along y: +1 when the taking cell is north
  const mouth = hiveTakingSide(hive) === 'north' ? 1 : -1;

  // ── THE PIVOT PLANE, for anything travelling THROUGH the box along its axis ──────────
  // `prev` may be inside (it came in through the mouth or the top) or outside (a fast shot
  // that crossed a face and the pivot in one tick — the face test below never sees it, because
  // this returns first).
  if (prev.y !== pos.y && Math.sign(prev.y - p.y) !== Math.sign(pos.y - p.y) && prev.y !== p.y) {
    const t = (p.y - prev.y) / (pos.y - prev.y);
    const at: Vec3 = {
      x: prev.x + (pos.x - prev.x) * t,
      y: p.y,
      z: prev.z + (pos.z - prev.z) * t,
    };
    // only if the crossing happened INSIDE the structure — a low shot under the down cell's
    // lip is on the tiles by the time it reaches the pivot, and one over the top is over it
    if (at.x >= min.x && at.x <= max.x && at.z >= min.z && at.z <= max.z) {
      const from = Math.sign(prev.y - p.y);
      return {
        pos: { x: at.x, y: p.y + from * EPS, z: at.z },
        vel: { x: vel.x * BB_HIVE_MISS_TANGENT, y: from * Math.abs(vel.y) * BB_HIVE_MISS_REST, z: vel.z },
      };
    }
  }

  if (inside(prev)) return null;

  // the slab crossed LAST is the face hit: for each axis the element was outside on, the
  // parameter along prev→pos at which it crossed that axis's near plane.
  let tHit = -1;
  let axis: 'x' | 'y' | 'z' | null = null;
  let sgn = 0; // the outward normal's sign along `axis`
  for (const ax of ['x', 'y', 'z'] as const) {
    const a = prev[ax];
    const b = pos[ax];
    const d = b - a;
    if (a < min[ax] && d > 0) {
      const t = (min[ax] - a) / d;
      if (t > tHit) {
        tHit = t;
        axis = ax;
        sgn = -1;
      }
    } else if (a > max[ax] && d < 0) {
      const t = (max[ax] - a) / d;
      if (t > tHit) {
        tHit = t;
        axis = ax;
        sgn = 1;
      }
    }
  }
  if (axis === null) return null;
  // the open top: a descent into the footprint from above is not a hit — see the header
  if (axis === 'z' && sgn === 1) return null;
  // the mouth: the taking cell's outer end is open at every height — see the header
  if (axis === 'y' && sgn === mouth) return null;

  const t = Math.max(0, Math.min(1, tHit));
  const hit: Vec3 = {
    x: prev.x + (pos.x - prev.x) * t,
    y: prev.y + (pos.y - prev.y) * t,
    z: prev.z + (pos.z - prev.z) * t,
  };
  hit[axis] = (sgn < 0 ? min[axis] : max[axis]) + sgn * EPS;

  const out: Vec3 = { ...vel };
  if (axis === 'z') {
    // the underside: reverse the climb, dump most of the run
    out.z = -Math.abs(vel.z) * BB_HIVE_MISS_REST;
    out.x = vel.x * BB_HIVE_MISS_TANGENT;
    out.y = vel.y * BB_HIVE_MISS_TANGENT;
  } else {
    const other = axis === 'x' ? 'y' : 'x';
    out[axis] = sgn * Math.abs(vel[axis]) * BB_HIVE_MISS_REST;
    out[other] = vel[other] * BB_HIVE_MISS_TANGENT;
    // `vz` stays: the face is vertical, and a ball still climbing when it hits keeps climbing
  }
  return { pos: hit, vel: out };
}
