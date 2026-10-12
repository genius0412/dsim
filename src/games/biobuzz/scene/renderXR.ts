/**
 * WEBXR DRIVER STATION — stand where a real driver stands, at 1:1 scale, in an `immersive-vr`
 * session (Safari on Apple Vision Pro; any WebXR browser).
 *
 * The scene is in field INCHES with +Z up; WebXR poses are METRES with +Y up. Rather than touch
 * the scene, the XR camera hangs off a RIG whose matrix carries the whole conversion: scale
 * 39.37 in/m, local +Y → world +Z, local −Z (WebXR "forward") → straight across the field from
 * the driver's own wall. The rig sits on the FLOOR at `driverEyePoint`'s x/y — the session is
 * `local-floor`, so the player's real head height, lean and step all come from the headset.
 *
 * While presenting, the window's `requestAnimationFrame` is frozen (measured on Vision Pro,
 * 2026-10-11), so the host's loop is driven from `renderer.setAnimationLoop` instead — see
 * `GameController.enterXR`. `navigator.getGamepads()` keeps working inside the session (verified
 * with a paired DualSense), so the input layer needs no change. Safari exposes no rumble
 * actuator there.
 */
import * as THREE from 'three';
import type { Alliance, World } from '../../../types';
import { bbRoleLabel } from '../config';
import { bbScoreWorld } from '../score';
import { driverEyePoint, type DriverRole } from '../graphics/driverEye';
import type { SceneXR } from '../../module';

const IN_PER_M = 39.37;
/** WebXR depth range, METRES (Vision Pro's minimum near plane is 0.1). */
const XR_NEAR_M = 0.1;
const XR_FAR_M = 200;
/**
 * Render scale against the headset's native framebuffer. Vision Pro's native size is very large;
 * at 0.5 with shadows off this scene holds 90 fps there (measured 2026-10-11: ~200k triangles,
 * ~2 ms CPU per frame), and the field still reads sharply at driver-station distance.
 */
const XR_FRAMEBUFFER_SCALE = 0.5;

export class BbXR implements SceneXR {
  /** the camera `renderer.render` is handed while presenting — three swaps in the XR pair */
  readonly camera = new THREE.PerspectiveCamera(70, 1, XR_NEAR_M, XR_FAR_M);
  private readonly rig = new THREE.Group();
  private readonly board: Scoreboard;
  private placedFor = '';
  private session: XRSession | null = null;
  private shadowsWere = true;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
  ) {
    this.rig.matrixAutoUpdate = false;
    this.rig.add(this.camera);
    scene.add(this.rig);
    this.board = new Scoreboard();
    this.board.mesh.visible = false;
    scene.add(this.board.mesh);
  }

  get presenting(): boolean {
    return this.session !== null;
  }

  static async supported(): Promise<boolean> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr || !window.isSecureContext) return false;
    return xr.isSessionSupported('immersive-vr').catch(() => false);
  }

  /** Must be called from a user gesture. `onFrame` is the host's loop; `onEnd` hands it back. */
  async enter(onFrame: (t: number) => void, onEnd: () => void): Promise<void> {
    const xr = (navigator as Navigator & { xr?: XRSystem }).xr;
    if (!xr) throw new Error('WebXR unavailable');
    const session = await xr.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
    this.renderer.xr.enabled = true;
    this.renderer.xr.setReferenceSpaceType('local-floor');
    this.renderer.xr.setFramebufferScaleFactor(XR_FRAMEBUFFER_SCALE);
    this.renderer.xr.setFoveation(1);
    await this.renderer.xr.setSession(session);
    this.session = session;
    this.placedFor = '';
    this.board.mesh.visible = true;
    // shadows off while presenting: two eyes at headset resolution is the expensive part
    this.shadowsWere = this.renderer.shadowMap.enabled;
    this.renderer.shadowMap.enabled = false;
    session.addEventListener('end', () => {
      this.session = null;
      this.renderer.shadowMap.enabled = this.shadowsWere;
      this.board.mesh.visible = false;
      this.renderer.setAnimationLoop(null);
      this.renderer.xr.enabled = false;
      onEnd();
    });
    this.renderer.setAnimationLoop((t) => onFrame(t));
  }

  exit(): void {
    void this.session?.end();
  }

  /** Re-place the rig when the local robot's alliance or TOP/BOTTOM role changes; refresh the board. */
  update(world: World, localRobotId: number | undefined, startCat: string | undefined): void {
    const robot = world.robots.find((r) => r.id === localRobotId) ?? world.robots[0];
    const alliance: Alliance = robot?.alliance ?? 'blue';
    const label = bbRoleLabel(startCat as Parameters<typeof bbRoleLabel>[0], alliance);
    const role: DriverRole = label === 'TOP' ? 'TOP' : 'BOTTOM';
    const key = `${alliance}|${role}`;
    if (key !== this.placedFor) {
      this.placeRig(alliance, role);
      this.placedFor = key;
    }
    this.board.update(world, alliance);
  }

  private placeRig(alliance: Alliance, role: DriverRole): void {
    // height is irrelevant here: `local-floor` puts the real head where it is
    const eye = driverEyePoint(alliance, role, 66);
    // face straight across the field from the driver's own wall (the wall is a constant-x plane)
    const facing = new THREE.Vector3(eye.x > 0 ? -1 : 1, 0, 0);
    const up = new THREE.Vector3(0, 0, 1);
    const back = facing.clone().negate(); // rig local +Z
    const right = new THREE.Vector3().crossVectors(up, back); // rig local +X = Y × Z
    const basis = new THREE.Matrix4().makeBasis(right, up, back);
    const m = new THREE.Matrix4()
      .makeTranslation(eye.x, eye.y, 0)
      .multiply(basis)
      .multiply(new THREE.Matrix4().makeScale(IN_PER_M, IN_PER_M, IN_PER_M));
    this.rig.matrix.copy(m);
    this.rig.matrixWorldNeedsUpdate = true;
    // the board hangs above the far wall, facing the driver, like a venue screen
    this.board.place(eye.x, facing);
  }
}

/** A venue-style score screen: red | time | blue, drawn on a canvas texture at 5 Hz. */
class Scoreboard {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly tex: THREE.CanvasTexture;
  private lastDraw = 0;

  constructor() {
    this.canvas.width = 1024;
    this.canvas.height = 256;
    this.ctx = this.canvas.getContext('2d')!;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    // 96 in × 24 in — readable across a 12 ft field
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(96, 24),
      new THREE.MeshBasicMaterial({ map: this.tex, toneMapped: false }),
    );
  }

  place(driverX: number, facing: THREE.Vector3): void {
    // across the field, above the far wall, tilted to face back toward the driver
    this.mesh.position.set(-driverX + facing.x * 30, 0, 84);
    this.mesh.up.set(0, 0, 1);
    this.mesh.lookAt(driverX, 0, 60);
  }

  update(world: World, mine: Alliance): void {
    const now = performance.now();
    if (now - this.lastDraw < 200) return;
    this.lastDraw = now;
    const s = bbScoreWorld(world);
    const m = world.match;
    const c = this.ctx;
    c.fillStyle = '#0b0d12';
    c.fillRect(0, 0, 1024, 256);
    c.fillStyle = '#c62828';
    c.fillRect(0, 0, 340, 256);
    c.fillStyle = '#1565c0';
    c.fillRect(684, 0, 340, 256);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillStyle = '#fff';
    c.font = 'bold 150px -apple-system, system-ui, sans-serif';
    c.fillText(String(s.red.total), 170, 140);
    c.fillText(String(s.blue.total), 854, 140);
    const phase = m.phase === 'freeplay' ? 'FREE DRIVE' : m.phase.toUpperCase();
    c.font = 'bold 44px -apple-system, system-ui, sans-serif';
    c.fillText(phase, 512, 60);
    if (m.phase !== 'freeplay') {
      const t = Math.max(0, Math.ceil(m.phaseTimeLeft));
      c.font = 'bold 110px -apple-system, system-ui, sans-serif';
      c.fillText(`${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`, 512, 160);
    }
    c.font = 'bold 30px -apple-system, system-ui, sans-serif';
    c.fillText('YOU', mine === 'red' ? 170 : 854, 236);
    this.tex.needsUpdate = true;
  }
}
