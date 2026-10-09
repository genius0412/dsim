import * as THREE from 'three';
import { BB_HALF_X } from '../config';
import { FINISHES, finishF0, type Finish, type FinishId } from '../graphics/finishes';
import type { BbFieldHandles } from './renderField';
import { BB_TILE_TOOTH, tileFlankGeometry, tileJunctions, tileSeamLean } from './renderTiles';
import {
  detailTexture,
  restoreTree,
  setShadow,
  surfaceRand,
  swapTree,
  tileNoise,
  TwinCache,
  type TwinRecipe,
} from './renderSurfaceKit';

/**
 * THE FIELD'S PHYSICAL FINISHES — the floor, the perimeter, the hives, the flowers, the tape, the
 * human players' boxes and the scoring elements, for the `materials: 'physical'` row. Part of the
 * lazy `renderSurfaces` chunk, and like everything in it: a SWAP onto cached twins, reverted by
 * the reverse assignment, never an edit of a base material (`renderSurfaceKit.ts`'s header).
 *
 * ── HOW A FIELD PART IS RECOGNISED ──────────────────────────────────────────────────────────
 * By the name `renderFieldGlb.ts`'s `styleScene` already gives every material it builds:
 * `<finish>#<rrggbb>@<node family>` (its cache key, kept on `mat.name` "for a console walk"; a
 * `splitOpenShells` clone adds `|doubleside`, stripped here). That key is exactly the resolution
 * the finish table needs — the SAME `metal#303030` is a powder-coated rail under `walls`, a
 * polypropylene casting under `hive_frame` and a nylon bracket under `flower` — so no tag had to
 * be added to the loader and standard mode is untouched. The handful of parts built in code
 * (the floor, the supplementary tape patch, the banner, the flower standoffs, the NECTAR box) are
 * recognised by their MESH names, which were already unique. The constants-built FALLBACK field
 * is left standard apart from its floor (it is the field a player sees only when the GLB failed).
 *
 * Pixel shares, measured off `field.glb` at the solved driver camera (the field survey's §4):
 * floor 86 % of all field pixels, wall glass 7.5 % and cell skins 3.7 % as overlays, black rails
 * 2.4 %, hive aluminium 1.3 %, ribs 1.7 %, pipes 0.5 %, tape 0.24 %. The work below is in that
 * order of care.
 *
 * ── THE CLEAR PANELS' SHADOWS ───────────────────────────────────────────────────────────────
 * Physical mode turns BOTH shadow flags off on every `depthWrite: false` mesh in the perimeter and
 * the hives (the wall glass, the cell skins, the tag bleed). `applyShadowFlags` sets cast and
 * receive on every wall/hive mesh, and under VSM a RECEIVER is drawn into the shadow map as well
 * (three 0.186 `WebGLShadowMap.js:526`), so today an 11-in wall of polycarbonate throws a solid
 * shadow band on every tier. It is fixed here, inside physical mode only, because standard mode
 * must stay the picture it is until the owner rules on the all-tier fix.
 */

// ═══════════════════════════════════════════════════════════════════════ the class table ══

/** what a part needs beyond a plain table twin */
type Special =
  /** the floor: analytic tile seams, wheel tracks, per-tile sheen (`FLOOR_*`) */
  | 'floor'
  /** bare aluminium tube/extrusion: a per-component AXIS TANGENT, anisotropy across the axis and
   * die lines along it (`TUBE_*`) */
  | 'tube'
  /** the clear sheets: true two-surface Fresnel instead of the 6.67× restore, plus wear */
  | 'clearWall'
  | 'clearSkin';

/** the GLB material key (`styleScene`'s `mat.name`), or a code-built mesh name → its finish */
interface FieldClass {
  finish: FinishId;
  /** detail sampling space. `object` for anything on the hives (the tray TILTS, and a world
   * projection would slide under it) and on the flowers (four copies of one geometry); `world`
   * for the floor, the tape and the perimeter, which never move. */
  space?: TwinRecipe['space'];
  axis?: TwinRecipe['axis'];
  keepColor?: boolean;
  special?: Special;
}

/**
 * THE CLASSES, keyed by `<finish>#<hex>@<family>`. Which CAD part sits behind each key is the
 * field survey's §1 table (`convert.py`'s `PART_RULES`); the reclassifications are the ones the
 * real-world survey (§4) sources: the hive's top corners are moulded POLYPROPYLENE, the flower's
 * wall bracket is NYLON, and the rails are powder-coated PAINT — all three were `metal` in the
 * CAD pipeline at metalness 0.7, which is none of them.
 */
export const FIELD_CLASSES: Readonly<Record<string, FieldClass>> = {
  // ── the perimeter ──
  /** am-2556a rails (+ the strap, webbing, which is under the tiles and never seen) */
  'metal#303030@walls': { finish: 'powderCoatBlack', space: 'world' },
  /** am-1226 corner-hinge rivets */
  'metal#b3b3b3@walls': { finish: 'rivet', space: 'world' },
  /** am-2580a panel links — bare aluminium */
  'metal#e6e6e6@walls': { finish: 'aluminiumTube', special: 'tube' },
  'glass#e6e6e6@walls': { finish: 'panelPolycarbonate', special: 'clearWall' },
  // ── the hives ──
  /** legs, top bar, foot bar, churros, pivot bracket, the tray braces and rocker plates */
  'metal#e6e6e6@hive_frame': { finish: 'aluminiumTube', special: 'tube' },
  /** the basket tube */
  'metal#e6e6e6@hive_tray': { finish: 'aluminiumTube', special: 'tube' },
  /** top corners (sourced PP), frame feet, axle and damper holders (moulded, APPROX) */
  'metal#303030@hive_frame': { finish: 'blackPolypropylene' },
  'plastic#4d4d4d@hive_frame': { finish: 'greyPlastic' },
  /** the ACM board's edges (its faces are the banner quads, below) */
  'plastic#e6e6e6@hive_frame': { finish: 'signVinylPanel' },
  'plastic#e6e6e6@hive_tray': { finish: 'cellSkinPetg', special: 'clearSkin' },
  /** goal ribs — alliance colour kept (the blue is already the owner's `#007be1`) */
  'plastic#ff0000@hive_tray': { finish: 'goalRibPolypropylene', keepColor: true },
  'plastic#0000ff@hive_tray': { finish: 'goalRibPolypropylene', keepColor: true },
  // ── the flowers ──
  'metal#303030@flower': { finish: 'blackNylon' },
  /** the upright ("peanut") extrusion and the supports */
  'metal#e6e6e6@flower': { finish: 'aluminiumTube', special: 'tube' },
  'plastic#303030@flower': { finish: 'flowerRingPolycarbonate', keepColor: true },
  'plastic#ffba52@flower': { finish: 'flowerRingPolycarbonate', keepColor: true },
  'plastic#641c65@flower': { finish: 'backstopPolycarbonate', keepColor: true },
  /** the pipe stands along the flower's own z (measured: object z −0.58…0.88 of a 17-in part) */
  'plastic#5fa73d@flower': { finish: 'hipsPipe', axis: 2 },
  // ── the tape ──
  /** ⚠️ TWO REDS, and this does not pick one: the GLB strips are the CAD's `#ff0000`, the corner
   * patch beside them `TAPE_GAFFER`'s `#e02020`. Both keep their own colour here; the survey's
   * sourced value (#e0231e, ProGaff photo #fe3432) is the owner's call to make. */
  'tape#ff0000@tape': { finish: 'tapeRed', space: 'world' },
  'tape#0000ff@tape': { finish: 'tapeBlue', space: 'world' },
};

/** code-built parts, by MESH name prefix (their materials carry no name) */
const MESH_CLASSES: readonly (readonly [string, FieldClass])[] = [
  ['tape:supplement:red', { finish: 'tapeRed', space: 'world' }],
  ['tape:supplement:blue', { finish: 'tapeBlue', space: 'world' }],
  ['bb-banner:', { finish: 'signVinylPanel' }],
  ['bb-flower-standoff:', { finish: 'mouldedNylon', keepColor: true }],
  // the human players' holding box (am-5706) and the NECTAR resting in it
  ['nectar-box:red:nectar', { finish: 'elementPolyethylene', keepColor: true }],
  ['nectar-box:blue:nectar', { finish: 'elementPolyethylene', keepColor: true }],
  ['nectar-box:', { finish: 'trayPolypropylene', keepColor: true }],
];

function classFor(m: THREE.Material, mesh: THREE.Mesh, floor: THREE.Object3D): FieldClass | null {
  if (mesh === floor) return { finish: 'tile', space: 'world', special: 'floor' };
  const byMat = m.name ? FIELD_CLASSES[m.name.replace(/\|doubleside$/, '')] : undefined;
  if (byMat) return byMat;
  for (const [prefix, cls] of MESH_CLASSES) if (mesh.name.startsWith(prefix)) return cls;
  return null;
}

/** is this mesh one of the clear sheets (its shadow policy changes in physical mode)? */
function isClearSheet(mesh: THREE.Mesh): boolean {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return mats.some((m) => m.transparent && m.depthWrite === false);
}

// ════════════════════════════════════════════════════════════════════ shader composition ══

/**
 * ADD a field-owned patch ON TOP of the kit's (which already composed the base's own hook): the
 * kit's hook runs first, this one edits what it produced, and the program key is extended so a
 * twin with this patch never shares a program with one without it. Once per twin — the caches
 * hand the same object back on every re-walk.
 */
function extendTwin(twin: THREE.MeshPhysicalMaterial, tag: string, edit: (shader: THREE.WebGLProgramParametersWithUniforms) => void): void {
  if (twin.userData.bbFieldPatch === tag) return;
  const prevHook = twin.onBeforeCompile;
  const prevKey = twin.customProgramCacheKey;
  twin.onBeforeCompile = (shader, renderer): void => {
    prevHook.call(twin, shader, renderer);
    edit(shader);
  };
  twin.customProgramCacheKey = (): string => `${prevKey.call(twin)}|${tag}`;
  twin.userData.bbFieldPatch = tag;
  twin.needsUpdate = true;
}

/** `src.replace(anchor, anchor + add)`, once — and a loud no-op if three moved the anchor, so a
 * patch can only ever be missing, never half-applied into a program that fails to compile. */
function after(src: string, anchor: string, add: string): string {
  if (!src.includes(anchor)) {
    // eslint-disable-next-line no-console
    console.warn(`[renderSurfaceField] shader anchor ${anchor} missing; a field patch is skipped.`);
    return src;
  }
  return src.replace(anchor, `${anchor}\n${add}`);
}

// ═════════════════════════════════════════════════════════════════════════════ the floor ══

/**
 * THE MAT — 86 % of the field's pixels, so the one surface that has to be right.
 *
 * WHAT THE CANVAS KEEPS: every colour. `TILE_MAT`, the 0…−8 % per-tile tone (`tileTone`, which is
 * already the batch variance AndyMark warns of, and never goes lighter than the mat), the painted
 * lip and groove — all of it is the HUD contrast measurement, and the twin reads the same `map`.
 * Nothing below makes a pixel LIGHTER than the canvas it sits on: the seam is a cavity, the tracks
 * multiply down, and the lip only turns the normal.
 *
 * WHAT IS NEW:
 *   • THE SEAM, ANALYTIC. The canvas has 14.5 texels to the inch, and at Extreme the driver-wall
 *     floor is seen at ~22 px/in, so the painted seam is magnified 1.5× and reads soft. The shader
 *     draws the same dovetail (`renderTiles.ts`'s `tileSeamPolyline`, reproduced exactly: the
 *     comb of flats and filleted flanks, the X at every junction, the 45° flip at the middle of
 *     every edge) as a distance field in world inches, and from it a real 0.03-in gap (occluded:
 *     a 5/8-in-deep slot is dark) and the die-cut rounded top edge (~1 mm radius, survey §1) as a
 *     normal that rolls into the gap. Both are BOX-FILTERED over the pixel's own footprint, so the
 *     line is crisp at 22 px/in and fades to nothing — onto the painted seam — at range instead of
 *     shimmering.
 *   • THE FOAM. The table's `stipple` (0.005–0.02-in cells) as triplanar detail, filtered by the
 *     ANISOTROPY ROW (`setDetailAnisotropy`). The standard floor has no relief map at all.
 *   • WEAR. Faint rubber TRACKS in wheel pairs 14 in apart (a typical 18-in chassis' track), at
 *     most 6 % darker and 0.1 rougher (`FLOOR_TRACK_*`), and a per-tile ±0.035 roughness from the
 *     patchy anti-static spray the event guide calls for (survey §1).
 * The FLAT tier (Low's straight 2-px grid) has no dovetail to match, so it gets the finish
 * and the wear but no seam.
 */
const FLOOR_GAP_HALF_IN = 0.015;
/** the die-cut edge's radius, in */
const FLOOR_LIP_R_IN = 0.05;
/** how much light the gap lets out at full coverage */
const FLOOR_GAP_OCCLUSION = 0.85;
/** per-tile roughness spread (anti-static spray), ± */
const FLOOR_TILE_ROUGH = 0.035;
/** the tracks: albedo multiplier down to 1 − this, roughness up by this, at full strength */
const FLOOR_TRACK_DARK = 0.06;
const FLOOR_TRACK_ROUGH = 0.1;
/** the track mask's texels over the whole field edge (≈ 3.6 per inch — a wheel is 1.5 in wide) */
const TRACK_TEX = 512;
/** wheel-to-wheel across a chassis, in (18-in robot, wheels inboard of the frame rail) */
const TRACK_GAUGE_IN = 14;
const TRACK_WHEEL_W_IN = 1.5;

/** the floor-space span the track mask covers — the mat's own, like the canvas */
const TRACK_SPAN_IN = 2 * BB_HALF_X;

let trackTex: THREE.DataTexture | null = null;
let fieldAnisotropy = 1;

/**
 * THE WHEEL-TRACK MASK, 512² over the mat, R = 0…1. Deterministic (`surfaceRand`), so the same
 * floor on every machine and in every export. A path is a closed Catmull-Rom loop through five
 * points — the way a robot actually circulates — drawn as TWO tracks a gauge apart, each a soft
 * 1.5-in band whose strength wanders along its length (a tyre does not print evenly). Accumulated
 * and clamped, so crossings darken a little more, as they do. DATA, made once and kept for the
 * document like the kit's detail tiles (1.3 MB with mips): every scene's floor draws the same one.
 */
function trackMask(): THREE.DataTexture | null {
  if (trackTex) return trackTex;
  const n = TRACK_TEX;
  const acc = new Float32Array(n * n);
  const perIn = n / TRACK_SPAN_IN;
  const toPx = (w: number): number => (w + TRACK_SPAN_IN / 2) * perIn;
  const rad = (TRACK_WHEEL_W_IN / 2) * perIn;
  const r2 = Math.ceil(rad * 1.6);
  const wander = tileNoise(24, 1, 31);
  let seed = 1000;
  const rnd = (): number => surfaceRand(seed++);
  for (let p = 0; p < 14; p++) {
    const pts: [number, number][] = [];
    for (let k = 0; k < 5; k++) pts.push([(rnd() - 0.5) * 118, (rnd() - 0.5) * 118]);
    const strength = 0.25 + 0.5 * rnd();
    const at = (seg: number, t: number): [number, number] => {
      const q = (i: number): [number, number] => pts[(((seg + i) % 5) + 5) % 5];
      const [p0, p1, p2, p3] = [q(-1), q(0), q(1), q(2)];
      const t2 = t * t;
      const t3 = t2 * t;
      const c = (a: number, b: number, cc: number, d: number): number =>
        0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
      return [c(p0[0], p1[0], p2[0], p3[0]), c(p0[1], p1[1], p2[1], p3[1])];
    };
    const steps = 160;
    for (let seg = 0; seg < 5; seg++) {
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        const [x, y] = at(seg, t);
        const [x2, y2] = at(seg, t + 1e-3);
        const len = Math.hypot(x2 - x, y2 - y) || 1;
        const nx = -(y2 - y) / len;
        const ny = (x2 - x) / len;
        const w = strength * (0.35 + 0.65 * wander((seg + t) / 5, 0.5)) * 0.06;
        for (const side of [-1, 1]) {
          const cx = toPx(x + (side * TRACK_GAUGE_IN * nx) / 2);
          const cy = toPx(y + (side * TRACK_GAUGE_IN * ny) / 2);
          const ix = Math.round(cx);
          const iy = Math.round(cy);
          for (let dy = -r2; dy <= r2; dy++) {
            for (let dx = -r2; dx <= r2; dx++) {
              const px = ix + dx;
              const py = iy + dy;
              if (px < 0 || py < 0 || px >= n || py >= n) continue;
              const d = Math.hypot(px - cx, py - cy) / rad;
              if (d >= 1.6) continue;
              acc[py * n + px] += w * Math.exp(-d * d * 1.8);
            }
          }
        }
      }
    }
  }
  const out = new Uint8Array(n * n * 4);
  for (let i = 0; i < n * n; i++) {
    const v = Math.round(Math.min(1, acc[i]) * 255);
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  try {
    const tex = new THREE.DataTexture(out, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = fieldAnisotropy;
    tex.name = 'bb-floor-tracks';
    tex.needsUpdate = true;
    trackTex = tex;
    return tex;
  } catch {
    return null;
  }
}

/**
 * THE FLOOR'S OWN SHADER. The seam function is `tileSeamPolyline` (`renderTiles.ts`) restated as a
 * distance. For the joint nearest the point across, and the junction-to-junction cell it is in
 * along (`tileJunctions`, virtual ones included, so the notched cut along the walls is drawn too),
 * the point goes into the cell's frame `(s, t)` and is measured against: the X cut at each end and
 * the 45° cut at the middle; the four flats nearest it, each clipped clear of those cuts; and the
 * three flanks nearest it, each the canonical `tileFlankPoints` shape (a fillet and the straight
 * flank, twice, point-symmetric) in its own frame, mirrored across the joint on every other one.
 * What comes back is the nearest point, so the lip's normal is the direction to it.
 */
const FLOOR_DECLS = /* glsl */ `
varying vec2 vBbFloor;
uniform sampler2D bbTrackMap;
uniform float bbTrackK;
#ifdef BB_SEAMS
uniform float bbJoint[ 7 ];
vec2 bbSegQ( vec2 p, vec2 a, vec2 b ) {
\tvec2 ab = b - a;
\treturn a + ab * clamp( dot( p - a, ab ) / max( dot( ab, ab ), 1e-8 ), 0.0, 1.0 );
}
// keep q if it is nearer p than the best so far (xy the point, z its distance)
void bbKeep( vec2 p, vec2 q, inout vec3 best ) {
\tfloat d = length( p - q );
\tif ( d < best.z ) best = vec3( q, d );
}
// half a flank in its own frame (the lower fillet, then the straight flank to the centre); the
// other half is this one turned about the centre, so sgn = -1 measures that one
void bbFlankHalf( vec2 p, float sgn, inout vec3 best ) {
\tvec2 q = p * sgn;
\tvec2 c = vec2( BB_E, BB_R - BB_A );
\tvec2 v = q - c;
\tfloat ang = atan( v.y, v.x );
\tvec2 e0 = vec2( BB_E, - BB_A );
\tvec2 arc = ang >= - 1.5707964 && ang <= BB_ARC_END
\t\t? c + BB_R * v / max( length( v ), 1e-6 )
\t\t: ( length( q - e0 ) < length( q - BB_T1 ) ? e0 : BB_T1 );
\tbbKeep( p, arc * sgn, best );
\tbbKeep( p, bbSegQ( q, BB_T1, vec2( 0.0 ) ) * sgn, best );
}
// the seam of one cell, in its frame: s along from the junction, t across, cell length L, lean sig
vec3 bbSeamCell( vec2 st, float L, float sig ) {
\tvec3 best = vec3( 0.0, 0.0, 1e4 );
\tfloat mid = 0.5 * L;
\tvec2 dg = vec2( 1.0, sig ) * BB_A;
\tbbKeep( st, bbSegQ( st, - dg, dg ), best );
\tbbKeep( st, bbSegQ( st, vec2( mid, 0.0 ) - dg, vec2( mid, 0.0 ) + dg ), best );
\tbbKeep( st, bbSegQ( st, vec2( L, 0.0 ) - dg, vec2( L, 0.0 ) + dg ), best );
\tfloat hp = 0.5 * BB_P;
\tfloat n0 = floor( ( st.x - mid ) / hp + 0.5 );
\tfor ( int i = - 2; i <= 1; i ++ ) {
\t\t// the flat after flank k: +sig A after an even one
\t\tfloat k = n0 + float( i );
\t\tfloat lvl = ( mod( k, 2.0 ) < 0.5 ? sig : - sig ) * BB_A;
\t\tfloat a = mid + k * hp + BB_E;
\t\tfloat b = mid + ( k + 1.0 ) * hp - BB_E;
\t\tif ( a + b < L ) { a = max( a, BB_A ); b = min( b, mid - BB_A ); }
\t\telse { a = max( a, mid + BB_A ); b = min( b, L - BB_A ); }
\t\tif ( b > a ) bbKeep( st, vec2( clamp( st.x, a, b ), lvl ), best );
\t}
\tfor ( int i = - 1; i <= 1; i ++ ) {
\t\tfloat k = n0 + float( i );
\t\tfloat g = mid + k * hp;
\t\tif ( abs( k ) < 0.5 || g < BB_A + BB_CLEAR || g > L - BB_A - BB_CLEAR ) continue;
\t\tfloat flip = mod( k, 2.0 ) < 0.5 ? sig : - sig;
\t\tvec2 p = vec2( st.x - g, st.y * flip );
\t\tvec3 lb = vec3( 0.0, 0.0, 1e4 );
\t\tbbFlankHalf( p, 1.0, lb );
\t\tbbFlankHalf( p, - 1.0, lb );
\t\tif ( lb.z < best.z ) best = vec3( g + lb.x, lb.y * flip, lb.z );
\t}
\treturn best;
}
// one axis' seams: distance to the nearest (x), the direction from it in (across, along) (yz),
// and how many joints lie below the point (w) — the tile index along this axis
vec4 bbSeamAxis( float across, float along, float sig ) {
\tfloat jat = bbJoint[ 0 ];
\tfor ( int i = 1; i < 7; i ++ ) if ( abs( across - bbJoint[ i ] ) < abs( across - jat ) ) jat = bbJoint[ i ];
\tfloat idx = 0.0;
\tfor ( int i = 1; i < 6; i ++ ) idx += step( bbJoint[ i ], across );
\tvec2 ab = vec2( bbJoint[ 0 ], bbJoint[ 1 ] );
\tfor ( int j = 1; j < 6; j ++ ) if ( along >= bbJoint[ j ] ) ab = vec2( bbJoint[ j ], bbJoint[ j + 1 ] );
\tvec2 st = vec2( along - ab.x, across - jat );
\tvec3 q = bbSeamCell( st, ab.y - ab.x, sig );
\tvec2 away = vec2( st.y - q.y, st.x - q.x );
\treturn vec4( q.z, away / max( q.z, 1e-5 ), idx );
}
#endif
`;

function floorEdit(seams: boolean): (shader: THREE.WebGLProgramParametersWithUniforms) => void {
  return (shader) => {
    const tracks = trackMask();
    shader.uniforms.bbTrackMap = { value: tracks };
    shader.uniforms.bbTrackK = { value: 1 / TRACK_SPAN_IN };
    const flank = tileFlankGeometry();
    const num = (v: number): string => v.toFixed(5);
    const defs = seams
      ? [
          '#define BB_SEAMS',
          `#define BB_P ${num(BB_TILE_TOOTH.period)}`,
          `#define BB_A ${num(BB_TILE_TOOTH.amplitude)}`,
          `#define BB_E ${num(flank.e)}`,
          `#define BB_R ${num(flank.r)}`,
          `#define BB_T1 vec2( ${num(flank.t1[0])}, ${num(flank.t1[1])} )`,
          `#define BB_ARC_END ${num(flank.arcEnd)}`,
          `#define BB_CLEAR ${num(flank.clear)}`,
          `#define BB_LEAN_X ${num(tileSeamLean('x'))}`,
          `#define BB_LEAN_Y ${num(tileSeamLean('y'))}`,
          '',
        ].join('\n')
      : '';
    if (seams) shader.uniforms.bbJoint = { value: tileJunctions() };
    shader.vertexShader = after(
      `varying vec2 vBbFloor;\n${shader.vertexShader}`,
      '#include <begin_vertex>',
      '\tvBbFloor = ( modelMatrix * vec4( transformed, 1.0 ) ).xy;',
    );
    let f = `${defs}${FLOOR_DECLS}\n${shader.fragmentShader}`;
    f = after(
      f,
      '#include <map_fragment>',
      // the tracks only ever multiply DOWN (the canvas is the contrast ceiling)
      `\tfloat bbTrack = texture2D( bbTrackMap, vBbFloor * bbTrackK + 0.5 ).r;\n\tdiffuseColor.rgb *= 1.0 - ${FLOOR_TRACK_DARK.toFixed(3)} * bbTrack;`,
    );
    const seamBlock = seams
      ? /* glsl */ `
\tvec4 bbSx = bbSeamAxis( vBbFloor.x, vBbFloor.y, BB_LEAN_X );
\tvec4 bbSy = bbSeamAxis( vBbFloor.y, vBbFloor.x, BB_LEAN_Y );
\t// the nearer seam, its outward gradient in WORLD (x, y)
\tfloat bbSd = bbSx.x;
\tvec2 bbSg = bbSx.yz;
\tif ( bbSy.x < bbSd ) { bbSd = bbSy.x; bbSg = bbSy.zy; }
\t// box-filter both profiles over this pixel's footprint, in inches
\tfloat bbH = max( 0.5 * length( fwidth( vBbFloor ) ), 1e-4 );
\tfloat bbGap = clamp( ( min( bbSd + bbH, ${FLOOR_GAP_HALF_IN.toFixed(4)} ) - max( bbSd - bbH, - ${FLOOR_GAP_HALF_IN.toFixed(4)} ) ) / ( 2.0 * bbH ), 0.0, 1.0 );
\t// the rounded edge: slope (G + R − x)/R across [G, G + R], averaged over the footprint
\tfloat bbLo = max( bbSd - bbH, ${FLOOR_GAP_HALF_IN.toFixed(4)} );
\tfloat bbHi = min( bbSd + bbH, ${(FLOOR_GAP_HALF_IN + FLOOR_LIP_R_IN).toFixed(4)} );
\tfloat bbLip = bbHi > bbLo ? ( ${(FLOOR_GAP_HALF_IN + FLOOR_LIP_R_IN).toFixed(4)} * ( bbHi - bbLo ) - 0.5 * ( bbHi * bbHi - bbLo * bbLo ) ) / ${FLOOR_LIP_R_IN.toFixed(4)} / ( 2.0 * bbH ) : 0.0;
\t// per-tile sheen: the anti-static spray does not go on evenly
\tfloat bbTileH = fract( sin( dot( vec2( bbSx.w, bbSy.w ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
\troughnessFactor += ( bbTileH - 0.5 ) * ${(2 * FLOOR_TILE_ROUGH).toFixed(3)};
`
      : '';
    f = after(
      f,
      '#include <roughnessmap_fragment>',
      `${seamBlock}\troughnessFactor = clamp( roughnessFactor + ${FLOOR_TRACK_ROUGH.toFixed(3)} * bbTrack, 0.0, 1.0 );`,
    );
    if (seams) {
      f = after(
        f,
        '#include <normal_fragment_maps>',
        /* glsl */ `
\tif ( bbLip > 0.0 && dot( bbSg, bbSg ) > 0.0 ) {
\t\t// rolls INTO the gap: the edge's normal leans toward the seam line
\t\tvec3 bbTv = normalize( ( viewMatrix * vec4( - normalize( bbSg ), 0.0, 0.0 ) ).xyz );
\t\tfloat bbL = min( bbLip, 0.95 );
\t\tnormal = normalize( normal * sqrt( 1.0 - bbL * bbL ) + bbTv * bbL );
\t}
`,
      );
      f = after(
        f,
        '#include <aomap_fragment>',
        /* glsl */ `
\t{
\t\tfloat bbOcc = 1.0 - ${FLOOR_GAP_OCCLUSION.toFixed(3)} * bbGap;
\t\treflectedLight.directDiffuse *= bbOcc;
\t\treflectedLight.indirectDiffuse *= bbOcc;
\t\treflectedLight.directSpecular *= bbOcc;
\t\treflectedLight.indirectSpecular *= bbOcc;
\t}
`,
      );
    }
    shader.fragmentShader = f;
  };
}

// ═══════════════════════════════════════════════════════════════════════ the clear sheets ══

/**
 * THE CLEAR SHEETS, REFLECTING WHAT POLYCARBONATE REFLECTS.
 *
 * `clearPanelMaterial` adds the specular back un-attenuated by alpha, and adds the ROOM term back
 * ×6.667 to undo `CLEAR_ENV_INTENSITY` 0.15. But in three 0.186 that damper does nothing:
 * `envMapIntensity` is read only when `material.envMap` is set, and nothing sets one
 * (`WebGLMaterials.js:405`), so the restore multiplies a term that was never damped and the walls
 * mirror at ~34 % face-on where the header meant 5.1 % (the reflection survey's headline). With
 * the room probe that would put a bright lamp grid on every wall.
 *
 * The twin keeps every one of the base's terms (the Beer–Lambert/Schlick alpha, the veil, the
 * bloom cap — the measured legibility work) and rewrites ONLY the mirror line: the specular lands
 * on screen at the SHEET's reflectance, both faces, `R₂ = 2R/(1 + R)` with Schlick's `R(θ)` from
 * the finish's own IOR — 9.8 % face-on for 3 mm polycarbonate, ~9.3 % for PETG, 16 % at 60°, and
 * toward 1 at grazing. The blend then multiplies by alpha, so the line adds `(R₂ − a)·spec / a`
 * and the screen gets `a·spec + (R₂ − a)·spec = R₂·spec` exactly.
 *
 * ⚠️ IF THE BASE HOOK CHANGES SHAPE, THERE IS NO TWIN. The mirror line is found by running the
 * base's own hook on a stub before the twin is ever made; if the line is not there, the sheet stays
 * on its standard material rather than risk the 6.67× restore under a sharp probe.
 */
const SPEC_LINE = /vec3 bbSpec = [^;]*;\s*outgoingLight \+= bbSpec \* [^;]*;/;

function baseMirrorLineFound(base: THREE.Material): boolean {
  if (base.onBeforeCompile === THREE.Material.prototype.onBeforeCompile) return false;
  const stub = {
    uniforms: {},
    vertexShader: '',
    fragmentShader: '#include <common>\nvoid main() {\n#include <opaque_fragment>\n}',
  } as unknown as THREE.WebGLProgramParametersWithUniforms;
  try {
    base.onBeforeCompile(stub, undefined as unknown as THREE.WebGLRenderer);
  } catch {
    return false;
  }
  return SPEC_LINE.test(stub.fragmentShader);
}

/**
 * WEAR ON A CLEAR SHEET, as ROUGHNESS ONLY — the alpha and the veil are the owner-tuned legibility
 * and are not touched. Uncoated polycarbonate scratches easily (survey §2): cleaning SWIRLS all
 * over (arcs of a wiping hand, 1–4 in radius), and on the PERIMETER's inside face a scuffed band
 * 0–5 in above the tiles where bumpers and wheels rub, taking the sheet from 0.05 to ~0.25.
 * Projected on the sheet's own plane (x or y by the normal, and z) — the GLB has no UVs.
 */
const WEAR_TEX = 256;
/** inches per repeat of the wear tile */
const WEAR_SCALE_IN = 12;
/** the band: top of full strength and top of any, inches above the tile */
const WEAR_BAND_FULL_IN = 2;
const WEAR_BAND_TOP_IN = 5.5;

let wearTex: THREE.DataTexture | null = null;

/** R — swirl scratches (0…1), G — the band's scuff mottle (0…1). Periodic, deterministic. */
function wearMask(): THREE.DataTexture | null {
  if (wearTex) return wearTex;
  const n = WEAR_TEX;
  const acc = new Float32Array(n * n);
  let seed = 5000;
  const rnd = (): number => surfaceRand(seed++);
  for (let a = 0; a < 90; a++) {
    // a wipe: a few concentric arcs from one hand motion
    const cx = rnd();
    const cy = rnd();
    const r0 = (1 + 3 * rnd()) / WEAR_SCALE_IN;
    const a0 = rnd() * Math.PI * 2;
    const span = 0.8 + 2.2 * rnd();
    const strength = 0.3 + 0.7 * rnd();
    const rings = 2 + Math.floor(rnd() * 4);
    for (let k = 0; k < rings; k++) {
      const r = r0 * (1 + 0.04 * k + 0.02 * rnd());
      const steps = Math.ceil(span * r * n * 2);
      const w = strength * (0.5 + 0.5 * rnd());
      for (let s = 0; s <= steps; s++) {
        const ang = a0 + (span * s) / steps;
        const x = Math.round((cx + r * Math.cos(ang)) * n);
        const y = Math.round((cy + r * Math.sin(ang)) * n);
        acc[(((y % n) + n) % n) * n + (((x % n) + n) % n)] += w;
      }
    }
  }
  const scuffA = tileNoise(6, 6, 41);
  const scuffB = tileNoise(24, 24, 42);
  const out = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const sw = Math.min(1, acc[i] * 0.6);
      const sc = Math.min(1, Math.max(0, (0.6 * scuffA(x / n, y / n) + 0.4 * scuffB(x / n, y / n) - 0.25) / 0.55));
      out[i * 4] = Math.round(sw * 255);
      out[i * 4 + 1] = Math.round(sc * 255);
      out[i * 4 + 2] = 0;
      out[i * 4 + 3] = 255;
    }
  }
  try {
    const tex = new THREE.DataTexture(out, n, n, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.colorSpace = THREE.NoColorSpace;
    tex.anisotropy = fieldAnisotropy;
    tex.name = 'bb-clear-wear';
    tex.needsUpdate = true;
    wearTex = tex;
    return tex;
  } catch {
    return null;
  }
}

interface ClearWear {
  /** roughness the swirls add at full strength */
  swirl: number;
  /** roughness the band adds at full strength (0 = no band: the cell skins) */
  band: number;
  /** sample in world inches (the static perimeter) or object inches (the TILTING tray) */
  world: boolean;
}

function clearEdit(finish: Finish, wear: ClearWear): (shader: THREE.WebGLProgramParametersWithUniforms) => void {
  const f0 = finishF0(finish.ior ?? 1.5);
  return (shader) => {
    shader.uniforms.bbWearMap = { value: wearMask() };
    shader.vertexShader = after(
      `varying vec3 vBbWearP;\nvarying vec3 vBbWearN;\n${shader.vertexShader}`,
      '#include <begin_vertex>',
      wear.world
        ? '\tvBbWearP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n\tvBbWearN = mat3( modelMatrix ) * objectNormal;'
        : '\tvBbWearP = transformed * vec3( length( modelMatrix[ 0 ].xyz ), length( modelMatrix[ 1 ].xyz ), length( modelMatrix[ 2 ].xyz ) );\n\tvBbWearN = objectNormal;',
    );
    let f = `varying vec3 vBbWearP;\nvarying vec3 vBbWearN;\nuniform sampler2D bbWearMap;\n${shader.fragmentShader}`;
    f = after(
      f,
      '#include <normal_fragment_maps>',
      /* glsl */ `
\t{
\t\tvec3 bbAn = abs( vBbWearN );
\t\tvec2 bbUv = bbAn.x > bbAn.y && bbAn.x > bbAn.z ? vBbWearP.yz : ( bbAn.y > bbAn.z ? vBbWearP.xz : vBbWearP.xy );
\t\tvec4 bbW = texture2D( bbWearMap, bbUv * ${(1 / WEAR_SCALE_IN).toFixed(5)} );
\t\tfloat bbR = roughnessFactor + ${wear.swirl.toFixed(3)} * bbW.r;
${
  wear.band > 0
    ? `\t\t// the INSIDE face: the side being drawn (three has already flipped \`normal\` toward the eye)
\t\t// whose world normal points back at the field centre
\t\tvec3 bbNw = ( vec4( normal, 0.0 ) * viewMatrix ).xyz;
\t\tfloat bbIn = smoothstep( -0.1, 0.3, dot( normalize( bbNw.xy + 1e-6 ), - normalize( vBbWearP.xy + 1e-6 ) ) );
\t\tfloat bbBand = 1.0 - smoothstep( ${WEAR_BAND_FULL_IN.toFixed(2)}, ${WEAR_BAND_TOP_IN.toFixed(2)}, vBbWearP.z );
\t\tbbR += ${wear.band.toFixed(3)} * bbIn * bbBand * ( 0.45 + 0.55 * bbW.g );`
    : ''
}
\t\troughnessFactor = clamp( bbR, 0.0, 1.0 );
\t}
`,
    );
    if (SPEC_LINE.test(f)) {
      f = f.replace(
        SPEC_LINE,
        [
          // SCHLICK for one face, from the finish's IOR, then both faces of the sheet
          `float bbFr = ${f0.toFixed(5)} + ${(1 - f0).toFixed(5)} * pow( 1.0 - bbCos, 5.0 );`,
          // three's specular already carries R(θ); this is the factor that takes it to R₂
          'float bbTwo = 2.0 / ( 1.0 + bbFr );',
          'outgoingLight += ( reflectedLight.directSpecular + reflectedLight.indirectSpecular ) * max( bbTwo - diffuseColor.a, 0.0 ) / max( diffuseColor.a, 0.02 );',
        ].join('\n'),
      );
    }
    shader.fragmentShader = f;
  };
}

// ══════════════════════════════════════════════════════════════════ the aluminium tubes ══

/**
 * BARE ALUMINIUM, AS A METAL WITH A GRAIN.
 *
 * Metalness 1 (the CAD pipeline's 0.7 was neither metal nor paint) and ANISOTROPY: an extruded
 * tube is smooth ALONG its die lines and rough ACROSS them, so its highlight stretches AROUND the
 * tube, perpendicular to the lines — which is why the anisotropy direction is the BITANGENT
 * (`anisotropyRotation` π/2): three raises the roughness along the direction it is given.
 *
 * Three builds the anisotropic frame from `vUv` or a `tangent` attribute (`normal_fragment_begin`)
 * and the field GLB has neither, so the tangent is MADE here: the parts are welded into connected
 * components by exact position (the creased-normal pass split every vertex, and the copies carry
 * the position bit for bit — `weldedComponents`' reasoning, reimplemented because that helper
 * writes an index onto a non-indexed geometry, and the standard picture must not depend on this
 * chunk having run), each component's principal axis is its covariance's dominant eigenvector (the
 * A-frame legs lean, so it cannot be a bounding-box axis), and every vertex gets that axis
 * projected onto its own face. Where a face is an END (axis ∥ normal) any perpendicular will do.
 *
 * ⚠️ THE ATTRIBUTE STAYS ON THE GEOMETRY AFTER A REVERT, AND THAT IS INERT: three binds `tangent`
 * only for a program with a normal map or anisotropy (`WebGLPrograms.js:308`), and no standard
 * material on these parts has either. Deleting it would leak its GL buffer instead.
 *
 * The die lines themselves are the table's `extrusion` tile, sampled on (along, across) in the
 * part's own inches from that same frame — the kit's triplanar detail has one fixed axis per twin,
 * and the legs, the top bar and the basket tube all run different ways.
 */
const TUBE_PATCH_VERT = /* glsl */ `
#ifdef USE_TANGENT
\t{
\t\tvec3 bbS = vec3( length( modelMatrix[ 0 ].xyz ), length( modelMatrix[ 1 ].xyz ), length( modelMatrix[ 2 ].xyz ) );
\t\tvec3 bbP = transformed * bbS;
\t\tvec3 bbT = normalize( objectTangent * bbS );
\t\tvec3 bbB = normalize( cross( normalize( objectNormal / bbS ), bbT ) + 1e-6 );
\t\tvBbAl = vec2( dot( bbP, bbT ), dot( bbP, bbB ) );
\t}
#else
\tvBbAl = vec2( 0.0 );
#endif
`;

function tubeEdit(finish: Finish): (shader: THREE.WebGLProgramParametersWithUniforms) => void {
  const d = finish.detail;
  return (shader) => {
    const tex = d ? detailTexture(d.kind) : null;
    if (!d || !tex) return;
    shader.uniforms.bbExtMap = { value: tex };
    shader.vertexShader = after(`varying vec2 vBbAl;\n${shader.vertexShader}`, '#include <begin_vertex>', TUBE_PATCH_VERT);
    let f = `varying vec2 vBbAl;\nuniform sampler2D bbExtMap;\n${shader.fragmentShader}`;
    f = after(
      f,
      '#include <normal_fragment_maps>',
      /* glsl */ `
#ifdef USE_TANGENT
\t{
\t\tvec4 bbE = texture2D( bbExtMap, vBbAl * ${(1 / d.scaleIn).toFixed(5)} );
\t\tvec3 bbTv = normalize( vTangent );
\t\tvec3 bbBv = normalize( vBitangent );
\t\tnormal = normalize( normal + ${d.normal.toFixed(3)} * ( ( bbE.x * 2.0 - 1.0 ) * bbTv + ( bbE.y * 2.0 - 1.0 ) * bbBv ) );
\t\troughnessFactor = clamp( roughnessFactor * ( 1.0 + ( bbE.z - 0.5 ) * ${(2 * d.rough).toFixed(3)} ), 0.0, 1.0 );
\t}
#endif
`,
    );
    shader.fragmentShader = f;
  };
}

/** geometries this chunk has already given (or failed to give) an axis tangent */
const TANGENT_DONE = new WeakMap<THREE.BufferGeometry, boolean>();

/** see the tube header. True when the geometry now carries a usable `tangent`. */
export function ensureAxisTangents(geo: THREE.BufferGeometry): boolean {
  const done = TANGENT_DONE.get(geo);
  if (done !== undefined) return done;
  const ok = buildAxisTangents(geo);
  TANGENT_DONE.set(geo, ok);
  return ok;
}

function buildAxisTangents(geo: THREE.BufferGeometry): boolean {
  if (geo.getAttribute('tangent')) return true;
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  if (!pos || !nrm || pos.count === 0) return false;
  const idx = geo.getIndex();
  const triCount = Math.floor((idx ? idx.count : pos.count) / 3);
  // weld by exact position
  const siteOf = new Map<string, number>();
  const rep = new Int32Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i)},${pos.getY(i)},${pos.getZ(i)}`;
    let s = siteOf.get(key);
    if (s === undefined) {
      s = siteOf.size;
      siteOf.set(key, s);
    }
    rep[i] = s;
  }
  const parent = new Int32Array(siteOf.size);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (a: number): number => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) {
      const nx = parent[a];
      parent[a] = r;
      a = nx;
    }
    return r;
  };
  const vtx = (t: number, k: number): number => (idx ? idx.getX(t * 3 + k) : t * 3 + k);
  for (let t = 0; t < triCount; t++) {
    const a = find(rep[vtx(t, 0)]);
    const b = find(rep[vtx(t, 1)]);
    const c = find(rep[vtx(t, 2)]);
    if (a !== b) parent[b] = a;
    const a2 = find(a);
    if (a2 !== find(c)) parent[find(c)] = a2;
  }
  // covariance per component, over its welded SITES (each counted once)
  const stats = new Map<number, Float64Array>();
  const seen = new Uint8Array(siteOf.size);
  for (let i = 0; i < pos.count; i++) {
    const s = rep[i];
    if (seen[s]) continue;
    seen[s] = 1;
    const r = find(s);
    let st = stats.get(r);
    if (!st) {
      st = new Float64Array(10);
      stats.set(r, st);
    }
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    st[0]++;
    st[1] += x;
    st[2] += y;
    st[3] += z;
    st[4] += x * x;
    st[5] += y * y;
    st[6] += z * z;
    st[7] += x * y;
    st[8] += x * z;
    st[9] += y * z;
  }
  const axisOf = new Map<number, THREE.Vector3>();
  for (const [r, st] of stats) {
    const k = st[0];
    const mx = st[1] / k;
    const my = st[2] / k;
    const mz = st[3] / k;
    const cxx = st[4] / k - mx * mx;
    const cyy = st[5] / k - my * my;
    const czz = st[6] / k - mz * mz;
    const cxy = st[7] / k - mx * my;
    const cxz = st[8] / k - mx * mz;
    const cyz = st[9] / k - my * mz;
    // power iteration from the widest diagonal axis
    const v = cxx >= cyy && cxx >= czz ? new THREE.Vector3(1, 0.1, 0.1) : cyy >= czz ? new THREE.Vector3(0.1, 1, 0.1) : new THREE.Vector3(0.1, 0.1, 1);
    for (let it = 0; it < 24; it++) {
      const nx = cxx * v.x + cxy * v.y + cxz * v.z;
      const ny = cxy * v.x + cyy * v.y + cyz * v.z;
      const nz = cxz * v.x + cyz * v.y + czz * v.z;
      const len = Math.hypot(nx, ny, nz);
      if (!(len > 0)) break;
      v.set(nx / len, ny / len, nz / len);
    }
    axisOf.set(r, v.lengthSq() > 0 ? v.normalize() : new THREE.Vector3(1, 0, 0));
  }
  const out = new Float32Array(pos.count * 4);
  const n = new THREE.Vector3();
  const t = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    const a = axisOf.get(find(rep[i])) ?? new THREE.Vector3(1, 0, 0);
    n.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    if (n.lengthSq() === 0) n.set(0, 0, 1);
    n.normalize();
    t.copy(a).addScaledVector(n, -a.dot(n));
    if (t.lengthSq() < 0.04) {
      // an end face: any direction in its plane
      t.set(Math.abs(n.x) < 0.9 ? 1 : 0, Math.abs(n.x) < 0.9 ? 0 : 1, 0).addScaledVector(n, -(Math.abs(n.x) < 0.9 ? n.x : n.y));
    }
    t.normalize();
    out[i * 4] = t.x;
    out[i * 4 + 1] = t.y;
    out[i * 4 + 2] = t.z;
    out[i * 4 + 3] = 1;
  }
  if (!out.every(Number.isFinite)) return false;
  geo.setAttribute('tangent', new THREE.Float32BufferAttribute(out, 4));
  return true;
}

// ═════════════════════════════════════════════════════════════════════════ the elements ══

/**
 * THE ELEMENTS RECEIVE SHADOWS — in physical mode, and only while they also CAST them.
 *
 * `setElementShadows` owns `castShadow` (the `elementShadows` row) and never sets
 * `receiveShadow`, and under VSM a receiver is drawn into the shadow map too
 * (`WebGLShadowMap.js:526`), so a separately stored receive flag would quietly make `blob` mode
 * cast. The flag is therefore made a READ of the cast flag for as long as the mode is on — an
 * accessor on the mesh instance that follows the row live with no call from the settings path —
 * and the plain data property goes back on revert.
 */
function followCastForReceive(mesh: THREE.Mesh): void {
  if (mesh.userData.bbBaseReceive !== undefined) return;
  mesh.userData.bbBaseReceive = mesh.receiveShadow;
  Object.defineProperty(mesh, 'receiveShadow', {
    configurable: true,
    enumerable: true,
    get: () => mesh.castShadow,
    // a write while the mode is on is the value to go back to, not a value to draw with
    set: (v: boolean) => {
      mesh.userData.bbBaseReceive = v;
    },
  });
}

function restoreReceive(mesh: THREE.Mesh): void {
  const base = mesh.userData.bbBaseReceive as boolean | undefined;
  if (base === undefined) return;
  delete mesh.userData.bbBaseReceive;
  Object.defineProperty(mesh, 'receiveShadow', { configurable: true, enumerable: true, writable: true, value: base });
}

// ═════════════════════════════════════════════════════════════════════════════ the applier ══

export interface FieldSurfaces {
  apply(field: BbFieldHandles): void;
  revert(field: BbFieldHandles): void;
  /** the POLLEN/NECTAR group (`renderElements.ts`) — a PE twin, emissive and colour untouched */
  applyElements(group: THREE.Object3D): void;
  revertElements(group: THREE.Object3D): void;
  /** the anisotropy row, for this file's own textures (the track and wear masks) */
  setAnisotropy(n: number): void;
  dispose(): void;
}

/** how a class becomes a recipe: the table entry, less a detail the field draws itself */
function recipeOf(id: string, cls: FieldClass, finish: Finish, opts: { anisotropy?: boolean; noDetail?: boolean; tweak?: TwinRecipe['tweak'] } = {}): TwinRecipe {
  return {
    id,
    finish: opts.noDetail ? { ...finish, detail: undefined } : finish,
    space: cls.space ?? 'object',
    axis: cls.axis,
    keepColor: cls.keepColor,
    anisotropy: opts.anisotropy,
    tweak: opts.tweak,
  };
}

export function createFieldSurfaces(): FieldSurfaces {
  // the field is built per scene, so its twins die with the scene
  const cache = new TwinCache(true);
  const elementCache = new TwinCache(true);

  const pickFor = (floor: THREE.Object3D) => (m: THREE.Material, mesh: THREE.Mesh): THREE.Material | null => {
    const cls = classFor(m, mesh, floor);
    if (!cls) return null;
    const finish: Finish = FINISHES[cls.finish];
    switch (cls.special) {
      case 'floor': {
        // the flat tier (Low's straight grid) has no dovetail to match (`renderField.ts`'s tag)
        const seams = m.userData.bbTileDetail === 'tiles';
        const twin = cache.get(m, recipeOf(`${cls.finish}:floor`, cls, finish));
        if (twin) extendTwin(twin, `bbf-floor${seams ? '-s' : ''}`, floorEdit(seams));
        return twin;
      }
      case 'tube': {
        const aniso = ensureAxisTangents(mesh.geometry);
        const twin = cache.get(
          m,
          recipeOf(aniso ? cls.finish : `${cls.finish}:iso`, cls, finish, {
            anisotropy: aniso,
            noDetail: true,
            tweak: (tw) => {
              tw.anisotropyRotation = Math.PI / 2;
            },
          }),
        );
        if (twin && aniso) extendTwin(twin, 'bbf-tube', tubeEdit(finish));
        return twin;
      }
      case 'clearWall':
      case 'clearSkin': {
        if (!baseMirrorLineFound(m)) return null;
        const twin = cache.get(m, recipeOf(cls.finish, cls, finish));
        if (twin) {
          const wear: ClearWear =
            cls.special === 'clearWall' ? { swirl: 0.05, band: 0.18, world: true } : { swirl: 0.04, band: 0, world: false };
          extendTwin(twin, `bbf-clear-${cls.special === 'clearWall' ? 'w' : 's'}`, clearEdit(finish, wear));
        }
        return twin;
      }
      default:
        return cache.get(m, recipeOf(cls.finish, cls, finish));
    }
  };

  const sheets = (root: THREE.Object3D): void =>
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && isClearSheet(mesh)) setShadow(mesh, false, false);
    });

  return {
    apply(field): void {
      swapTree(field.group, pickFor(field.floor));
      sheets(field.walls);
      sheets(field.hives.red);
      sheets(field.hives.blue);
    },
    revert(field): void {
      cache.release(restoreTree(field.group));
    },
    applyElements(group): void {
      const finish = FINISHES.elementPolyethylene;
      swapTree(group, (m, mesh) => {
        if (mesh.name !== 'bb-pollen' && mesh.name !== 'bb-nectar') return null;
        // the emissive is COPIED, not added and not removed: it is a legibility decision
        // (`renderElements.ts`) the owner has not ruled on
        return elementCache.get(m, { id: 'elementPolyethylene', finish, keepColor: true, space: 'world' });
      });
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh && (mesh.name === 'bb-pollen' || mesh.name === 'bb-nectar')) followCastForReceive(mesh);
      });
    },
    revertElements(group): void {
      group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) restoreReceive(mesh);
      });
      elementCache.release(restoreTree(group));
    },
    setAnisotropy(n): void {
      fieldAnisotropy = Math.max(1, n);
      for (const tex of [trackTex, wearTex]) {
        if (tex && tex.anisotropy !== fieldAnisotropy) {
          tex.anisotropy = fieldAnisotropy;
          tex.needsUpdate = true;
        }
      }
    },
    dispose(): void {
      cache.releaseAll();
      elementCache.releaseAll();
    },
  };
}
