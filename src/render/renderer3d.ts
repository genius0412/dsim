import * as THREE from 'three';
import type { World, Alliance } from '../types';
import * as C from '../config';
import { goalCenter, goalFaceNormal, classifierRect } from '../sim/field';

export class Renderer3D {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
  private renderer: THREE.WebGLRenderer;
  private canvas: HTMLCanvasElement;

  private fieldMesh: THREE.Mesh;
  private wallMeshes: THREE.Mesh[] = [];
  private goalMeshes: Record<Alliance, THREE.Group> = { red: new THREE.Group(), blue: new THREE.Group() };
  private robotMeshes: Map<number, THREE.Group> = new Map();
  private robotHopperMeshes: Map<number, THREE.Group> = new Map();
  private ballMeshes: Map<number, THREE.Mesh> = new Map();

  private alliance: Alliance = 'blue';

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(canvas.width, canvas.height);
    this.renderer.setClearColor(0x23262b);

    // Lighting
    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    this.scene.add(ambient);
    const sun = new THREE.DirectionalLight(0xffffff, 0.8);
    sun.position.set(50, 100, 50);
    this.scene.add(sun);

    this.initField();
  }

  private initField() {
    // Field floor
    const floorGeo = new THREE.PlaneGeometry(C.FIELD_HALF * 2, C.FIELD_HALF * 2);
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x2c3038 });
    this.fieldMesh = new THREE.Mesh(floorGeo, floorMat);
    this.fieldMesh.rotation.x = -Math.PI / 2;
    this.scene.add(this.fieldMesh);

    // Legal Launch Zones (white outlines)
    const zoneMat = new THREE.LineBasicMaterial({ color: 0xffffff });

    // Big launch triangle: apex (0,0), base (±72, 72)
    const bigPoints = [
      new THREE.Vector3(0, 0.1, 0),
      new THREE.Vector3(C.FIELD_HALF, 0.1, C.FIELD_HALF),
      new THREE.Vector3(-C.FIELD_HALF, 0.1, C.FIELD_HALF),
      new THREE.Vector3(0, 0.1, 0),
    ];
    const bigGeo = new THREE.BufferGeometry().setFromPoints(bigPoints);
    const bigLine = new THREE.Line(bigGeo, zoneMat);
    this.scene.add(bigLine);

    // Small audience triangle: apex (0, -48), base (±24, -72)
    const smallPoints = [
      new THREE.Vector3(0, 0.1, -48),
      new THREE.Vector3(24, 0.1, -C.FIELD_HALF),
      new THREE.Vector3(-24, 0.1, -C.FIELD_HALF),
      new THREE.Vector3(0, 0.1, -48),
    ];
    const smallGeo = new THREE.BufferGeometry().setFromPoints(smallPoints);
    const smallLine = new THREE.Line(smallGeo, zoneMat);
    this.scene.add(smallLine);

    // Boundary walls
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x4b5563 });
    const wallH = 12;
    const wallT = 2;

    const walls = [
      { w: wallT, h: wallH, d: C.FIELD_HALF * 2, x: C.FIELD_HALF, z: 0, ry: Math.PI / 2 },
      { w: wallT, h: wallH, d: C.FIELD_HALF * 2, x: -C.FIELD_HALF, z: 0, ry: Math.PI / 2 },
    ];

    for (const wall of walls) {
      const geo = new THREE.BoxGeometry(wall.w, wall.h, wall.d);
      const mesh = new THREE.Mesh(geo, wallMat);
      mesh.position.set(wall.x, wall.h / 2, wall.z);
      mesh.rotation.y = wall.ry;
      this.scene.add(mesh);
      this.wallMeshes.push(mesh);
    }

    // Goals & Classifiers
    for (const a of ['red', 'blue'] as Alliance[]) {
      const group = this.goalMeshes[a];
      const gCenter = goalCenter(a);
      const n = goalFaceNormal(a);

      // Goal face
      const faceGeo = new THREE.BoxGeometry(20, 38, 1);
      const faceMat = new THREE.MeshStandardMaterial({ color: a === 'red' ? 0xef4444 : 0x3b82f6 });
      const face = new THREE.Mesh(faceGeo, faceMat);
      face.position.set(gCenter.x, 19, gCenter.y);
      face.lookAt(gCenter.x + n.x * 10, 19, gCenter.y + n.y * 10);
      group.add(face);

      // Classifier rail
      const rect = classifierRect(a);
      const railGeo = new THREE.BoxGeometry(rect.x1 - rect.x0, 1, rect.y1 - rect.y0);
      const railMat = new THREE.MeshStandardMaterial({ color: 0x4b5563 });
      const rail = new THREE.Mesh(railGeo, railMat);
      rail.position.set((rect.x0 + rect.x1) / 2, 0.5, (rect.y0 + rect.y1) / 2);
      group.add(rail);

      this.scene.add(group);
    }
  }

  configure(canvas: HTMLCanvasElement, alliance: Alliance) {
    this.canvas = canvas;
    this.alliance = alliance;
    this.renderer.setSize(canvas.width, canvas.height);

    // Camera position from the side
    const dist = 250;
    const xPos = alliance === 'blue' ? dist : -dist;
    this.camera.position.set(xPos, 120, 0);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
  }

  render(world: World, lastCmd: any) {
    // Update Robots
    for (const r of world.robots) {
      let group = this.robotMeshes.get(r.id);
      if (!group) {
        group = new THREE.Group();

        // Main chassis
        const chassisGeo = new THREE.BoxGeometry(r.spec.length, 10, r.spec.width);
        const chassisMat = new THREE.MeshStandardMaterial({ color: r.alliance === 'red' ? 0xef4444 : 0x3b82f6 });
        const chassis = new THREE.Mesh(chassisGeo, chassisMat);
        chassis.position.y = 5;
        group.add(chassis);

        // Intake indicator
        const intake = C.INTAKE_PRESETS[r.spec.intake];
        const intakeGeo = new THREE.BoxGeometry(intake.reach, 8, r.spec.width * 0.8);
        const intakeMat = new THREE.MeshStandardMaterial({ color: 0xcccccc });
        const intakeMesh = new THREE.Mesh(intakeGeo, intakeMat);
        intakeMesh.position.set(r.spec.length / 2 + intake.reach / 2, 4, 0);
        group.add(intakeMesh);

        // Shooter indicator (Turret)
        const shooterGeo = new THREE.CylinderGeometry(2, 2, 8, 16);
        const shooterMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
        const shooter = new THREE.Mesh(shooterGeo, shooterMat);
        shooter.rotation.z = Math.PI / 2;
        shooter.position.set(r.spec.length * C.TURRET_OFFSET_FRAC, 7, 0);
        group.add(shooter);

        this.scene.add(group);
        this.robotMeshes.set(r.id, group);
      }

      group.position.set(r.pos.x, 0, r.pos.y);
      group.rotation.y = -r.heading;

      // Update shooter rotation relative to robot
      const shooter = group.children[2] as THREE.Mesh;
      shooter.rotation.y = r.turretHeading - r.heading;

      // Update Hopper Indicator
      let hopperGroup = this.robotHopperMeshes.get(r.id);
      if (!hopperGroup) {
        hopperGroup = new THREE.Group();
        this.scene.add(hopperGroup);
        this.robotHopperMeshes.set(r.id, hopperGroup);
      }
      hopperGroup.position.set(r.pos.x, 0, r.pos.y);
      hopperGroup.rotation.y = -r.heading;

      // Clear and redraw balls in hopper
      hopperGroup.clear();
      r.hopper.forEach((color, i) => {
        const geo = new THREE.SphereGeometry(C.BALL_RADIUS);
        const mat = new THREE.MeshStandardMaterial({ color: color === 'purple' ? 0xa855f7 : 0x22c55e });
        const ball = new THREE.Mesh(geo, mat);
        // Distribute balls along the chassis length
        const xPos = (i - 1) * (r.spec.length * 0.2);
        ball.position.set(xPos, 10 + C.BALL_RADIUS, 0);
        hopperGroup.add(ball);
      });
    }

    // Update Balls
    for (const b of world.balls) {
      let mesh = this.ballMeshes.get(b.id);
      if (!mesh) {
        const geo = new THREE.SphereGeometry(C.BALL_RADIUS);
        const mat = new THREE.MeshStandardMaterial({ color: b.color === 'purple' ? 0xa855f7 : 0x22c55e });
        mesh = new THREE.Mesh(geo, mat);
        this.scene.add(mesh);
        this.ballMeshes.set(b.id, mesh);
      }
      mesh.position.set(b.pos.x, b.z + C.BALL_RADIUS, b.pos.y);
    }

    // Cleanup dead balls
    const currentBallIds = new Set(world.balls.map(b => b.id));
    for (const [id, mesh] of this.ballMeshes) {
      if (!currentBallIds.has(id)) {
        this.scene.remove(mesh);
        this.ballMeshes.delete(id);
      }
    }
  }

  cleanup() {
    this.robotMeshes.forEach(g => this.scene.remove(g));
    this.robotMeshes.clear();
    this.robotHopperMeshes.forEach(g => this.scene.remove(g));
    this.robotHopperMeshes.clear();
    this.ballMeshes.forEach(m => this.scene.remove(m));
    this.ballMeshes.clear();
  }

  draw() {
    this.renderer.render(this.scene, this.camera);
  }
}
