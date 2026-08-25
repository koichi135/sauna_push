import RAPIER from '@dimforge/rapier3d-compat';
import { BALANCE } from '../core/BalanceConfig';
import {
  GROUP_ITEM,
  GROUP_PUSHER,
  GROUP_SENSOR_LOST,
  GROUP_SENSOR_PAYOUT,
  GROUP_STONE,
  GROUP_WALL,
} from './layers';

export type BodyKind = 'stone' | 'item';

export interface TrackedBody {
  readonly id: number;
  readonly kind: BodyKind;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  /** アイテムの場合のみ。どのアイテムかを識別する */
  readonly itemId?: string;
  /** 衝突音の判定に使う直前フレームの速度 */
  prevSpeed: number;
}

export type SensorKind = 'payout' | 'lost';

/** Rapier の初期化は非同期。アプリ起動時に一度だけ呼ぶ。 */
let rapierReady: Promise<void> | null = null;
export function initPhysics(): Promise<void> {
  rapierReady ??= RAPIER.init();
  return rapierReady;
}

export class PhysicsWorld {
  readonly world: RAPIER.World;
  private readonly eventQueue: RAPIER.EventQueue;
  private readonly bodies = new Map<number, TrackedBody>();
  /** collider handle → センサー種別 */
  private readonly sensorKinds = new Map<number, SensorKind>();
  /** collider handle → TrackedBody。センサー衝突からの逆引き用 */
  private readonly colliderToBody = new Map<number, TrackedBody>();
  private nextId = 1;

  private pusherBody!: RAPIER.RigidBody;

  constructor() {
    const f = BALANCE.field;
    this.world = new RAPIER.World({ x: 0, y: BALANCE.physics.gravity, z: 0 });
    this.world.timestep = BALANCE.physics.fixedTimeStep;
    this.eventQueue = new RAPIER.EventQueue(true);

    this.buildStaticGeometry();
    this.buildPusher();
    this.buildSensors();
    void f;
  }

  // ---------------------------------------------------------------- 盤面

  private buildStaticGeometry(): void {
    const f = BALANCE.field;
    const halfW = f.halfWidth;
    // 下段テーブル: ペイアウト境界からプッシャー前進端の奥まで。
    // 厚み 0.02 の板を、上面が lowerTableY になるように置く。
    const tableFrontZ = f.payoutZ;
    const tableBackZ = f.backZ;
    const tableHalfDepth = (tableBackZ - tableFrontZ) / 2;
    const tableCenterZ = (tableBackZ + tableFrontZ) / 2;
    this.addStaticBox(0, f.lowerTableY - 0.01, tableCenterZ, halfW, 0.01, tableHalfDepth);

    // 奥の固定壁（仕様 3章「段差は奥の固定壁で表現」）。
    this.addStaticBox(
      0,
      f.shelfTopY + f.wallHeight / 2,
      f.backWallZ,
      halfW + 0.02,
      f.wallHeight,
      0.01,
    );

    // 投入シュート（フード兼用）
    this.buildChute();

    // 側面レール: 奥側（railFrontZ 〜 railBackZ）のみ。
    // これより手前は左右が開いており、押し出されたストーンがロスト溝へ落ちる（仕様 3章）。
    // 下段テーブル面から立ち上げること。プッシャー上面から上だけだと、
    // 下段に落ちたストーンがレールの下をすり抜けて左右へ流出してしまう。
    const railBottom = f.lowerTableY;
    const railTop = f.railTopY;
    const railHalfHeight = (railTop - railBottom) / 2;
    const railHalfDepth = (f.railBackZ - f.railFrontZ) / 2;
    const railCenterZ = (f.railBackZ + f.railFrontZ) / 2;
    for (const sign of [-1, 1]) {
      this.addStaticBox(
        sign * (halfW + 0.01),
        railBottom + railHalfHeight,
        railCenterZ,
        0.01,
        railHalfHeight,
        railHalfDepth,
      );
    }
  }

  /**
   * 投入シュート。奥から手前へ下る傾いた板で、投入されたストーンを
   * プッシャー板の前寄りへ配給する。同時に、その前縁が後退する板から
   * ストーンを掻き落とすフードとして働く（BalanceConfig の chute 参照）。
   */
  private buildChute(): void {
    const c = BALANCE.field.chute;
    const dz = c.backZ - c.frontZ;
    const dy = c.backY - c.frontY;
    const length = Math.hypot(dz, dy);
    // 奥ほど高い斜面にする。X 軸まわりに -angle 回転させると
    // ローカル +Z が (0, +sin, +cos) を向き、Z が増えるほど高くなる。
    const angle = -Math.atan2(dy, dz);

    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed()
        .setTranslation(0, (c.frontY + c.backY) / 2 + c.thickness / 2, (c.frontZ + c.backZ) / 2)
        .setRotation({ x: Math.sin(angle / 2), y: 0, z: 0, w: Math.cos(angle / 2) }),
    );
    const desc = RAPIER.ColliderDesc.cuboid(BALANCE.field.halfWidth, c.thickness / 2, length / 2)
      .setFriction(c.friction)
      .setRestitution(0.02)
      .setCollisionGroups(GROUP_WALL);
    this.world.createCollider(desc, body);
  }

  private addStaticBox(
    x: number,
    y: number,
    z: number,
    hx: number,
    hy: number,
    hz: number,
  ): RAPIER.Collider {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setFriction(0.5)
      .setRestitution(0.02)
      .setCollisionGroups(GROUP_WALL);
    return this.world.createCollider(desc, body);
  }

  // ---------------------------------------------------------------- プッシャー

  /**
   * プッシャーは Kinematic Position Based（仕様 4章）。
   * Dynamic にするとストーンに押し返されるため厳禁。
   */
  private buildPusher(): void {
    const f = BALANCE.field;
    const p = BALANCE.pusher;
    const desc = RAPIER.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(0, f.shelfTopY - p.height / 2, p.baseZ)
      .setCcdEnabled(true);
    this.pusherBody = this.world.createRigidBody(desc);

    // 押し板本体。上面が shelfTopY、下面が下段テーブル面より上にくる厚み。
    const shelf = RAPIER.ColliderDesc.cuboid(f.halfWidth, p.height / 2, p.depth / 2)
      .setFriction(0.5)
      .setRestitution(0.02)
      .setCollisionGroups(GROUP_PUSHER);
    this.world.createCollider(shelf, this.pusherBody);
    // 板の後端はシュート下に隠れるので、後端リップは付けない。
    // 板と一緒に動くリップを付けるとストーンが板上に閉じ込められ、前縁へ送られなくなる。
  }

  /** プッシャーの Z 位置を設定する。Pusher クラスが固定ステップごとに呼ぶ。 */
  setPusherZ(z: number): void {
    const f = BALANCE.field;
    const p = BALANCE.pusher;
    this.pusherBody.setNextKinematicTranslation({ x: 0, y: f.shelfTopY - p.height / 2, z });
  }

  getPusherZ(): number {
    return this.pusherBody.translation().z;
  }

  // ---------------------------------------------------------------- センサー

  /**
   * ペイアウト口とロスト溝。Rapier の Sensor Collider を使い剛体を止めない（仕様 3章）。
   * どちらも落下面より下に置き、盤面から落ちたものだけを拾う。
   */
  private buildSensors(): void {
    const f = BALANCE.field;
    const sensorY = f.killPlaneY + 0.05;

    // 手前のペイアウト口: payoutZ より手前
    this.addSensor(0, sensorY, f.payoutZ - 0.15, f.halfWidth + 0.1, 0.05, 0.15, GROUP_SENSOR_PAYOUT, 'payout');

    // 左右のロスト溝: |X| > halfWidth
    for (const sign of [-1, 1]) {
      this.addSensor(
        sign * (f.halfWidth + 0.12),
        sensorY,
        0,
        0.12,
        0.05,
        f.backZ + 0.2,
        GROUP_SENSOR_LOST,
        'lost',
      );
    }

    // 取りこぼしの受け皿: 上記どちらにも当たらず落ちたものを lost 扱いにする。
    // これが無いと剛体が永久に落下し続け、上限 120 を無駄に食う。
    this.addSensor(0, f.killPlaneY - 0.1, 0, 2, 0.05, 2, GROUP_SENSOR_LOST, 'lost');
  }

  private addSensor(
    x: number,
    y: number,
    z: number,
    hx: number,
    hy: number,
    hz: number,
    groups: number,
    kind: SensorKind,
  ): void {
    const body = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz)
      .setSensor(true)
      .setCollisionGroups(groups)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const collider = this.world.createCollider(desc, body);
    this.sensorKinds.set(collider.handle, kind);
  }

  // ---------------------------------------------------------------- 動的ボディ

  spawnStone(x: number, y: number, z: number, vz: number): TrackedBody {
    const s = BALANCE.physics.stone;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setLinvel(0, 0, vz)
      // 落下中に少し回転させると、山の上で綺麗に重なりすぎず自然に散る
      .setAngvel({ x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: (Math.random() - 0.5) * 2 })
      .setLinearDamping(s.linearDamping)
      .setAngularDamping(s.angularDamping)
      // ストーンの CCD は無効（仕様 3章）。数が多く、コストに見合わない
      .setCcdEnabled(false);
    const body = this.world.createRigidBody(desc);
    const collider = RAPIER.ColliderDesc.cylinder(s.thickness / 2, s.radius)
      .setFriction(s.friction)
      .setRestitution(s.restitution)
      .setDensity(s.density)
      .setCollisionGroups(GROUP_STONE)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const col = this.world.createCollider(collider, body);
    return this.track('stone', body, col);
  }

  spawnItem(itemId: string, x: number, y: number, z: number): TrackedBody {
    const i = BALANCE.physics.item;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setLinearDamping(i.linearDamping)
      .setAngularDamping(i.angularDamping)
      // アイテムは数が少なく取りこぼすと体験が壊れるので CCD 有効（仕様 3章）
      .setCcdEnabled(true);
    const body = this.world.createRigidBody(desc);
    const collider = RAPIER.ColliderDesc.cylinder(i.thickness / 2, i.radius)
      .setFriction(i.friction)
      .setRestitution(i.restitution)
      .setDensity(i.density)
      .setCollisionGroups(GROUP_ITEM)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const col = this.world.createCollider(collider, body);
    return this.track('item', body, col, itemId);
  }

  private track(
    kind: BodyKind,
    body: RAPIER.RigidBody,
    collider: RAPIER.Collider,
    itemId?: string,
  ): TrackedBody {
    const tracked: TrackedBody = {
      id: this.nextId++,
      kind,
      body,
      collider,
      prevSpeed: 0,
      ...(itemId !== undefined ? { itemId } : {}),
    };
    this.bodies.set(tracked.id, tracked);
    this.colliderToBody.set(collider.handle, tracked);
    return tracked;
  }

  remove(tracked: TrackedBody): void {
    if (!this.bodies.has(tracked.id)) return;
    this.bodies.delete(tracked.id);
    this.colliderToBody.delete(tracked.collider.handle);
    this.world.removeRigidBody(tracked.body);
  }

  get bodyCount(): number {
    return this.bodies.size;
  }

  all(): IterableIterator<TrackedBody> {
    return this.bodies.values();
  }

  /**
   * 剛体数が上限を超えたぶんだけ、最も奥かつスリープ中のストーンを消す（仕様 3章）。
   * 消した数を返す。呼び出し側が STONE_CULLED を発火する。
   *
   * スリープ中を優先するが、そこで打ち切らない。プッシャーが常時盤面を揺らすため
   * スリープするストーンはほとんど無く、スリープ限定にすると上限が機能しない
   * （実測で 120 上限に対し 390 個まで増えた）。足りなければ奥のものから
   * 起きているストーンも消して、必ず上限まで戻す。
   */
  cullExcess(): number {
    const limit = BALANCE.physics.maxActiveBodies;
    const excess = this.bodies.size - limit;
    if (excess <= 0) return 0;

    const sleeping: TrackedBody[] = [];
    const awake: TrackedBody[] = [];
    for (const t of this.bodies.values()) {
      if (t.kind !== 'stone') continue;
      (t.body.isSleeping() ? sleeping : awake).push(t);
    }
    // 奥（Z が大きい）から消す。プレイヤーが見ている手前の山は最後まで残す。
    const byDepth = (a: TrackedBody, b: TrackedBody) =>
      b.body.translation().z - a.body.translation().z;
    sleeping.sort(byDepth);
    awake.sort(byDepth);

    let removed = 0;
    for (const t of [...sleeping, ...awake]) {
      if (removed >= excess) break;
      this.remove(t);
      removed += 1;
    }
    return removed;
  }

  // ---------------------------------------------------------------- ステップ

  /**
   * 1固定ステップ進める。センサー到達と衝突音の情報を返す。
   * 呼び出し側は返ってきた TrackedBody を必ず remove すること。
   */
  step(): {
    payouts: TrackedBody[];
    losts: TrackedBody[];
    impacts: { x: number; y: number; z: number; speed: number }[];
  } {
    const payouts: TrackedBody[] = [];
    const losts: TrackedBody[] = [];
    const seen = new Set<number>();

    this.world.step(this.eventQueue);

    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const kind = this.sensorKinds.get(h1) ?? this.sensorKinds.get(h2);
      if (kind === undefined) return;
      const bodyHandle = this.sensorKinds.has(h1) ? h2 : h1;
      const tracked = this.colliderToBody.get(bodyHandle);
      if (!tracked || seen.has(tracked.id)) return;
      seen.add(tracked.id);
      if (kind === 'payout') payouts.push(tracked);
      else losts.push(tracked);
    });

    const impacts = this.collectImpacts();
    return { payouts, losts, impacts };
  }

  /**
   * 速度の急変から衝突を検出する（音用）。
   * Rapier の接触イベントを全ストーンで有効にするより安く、鳴らしたい瞬間とよく一致する。
   */
  private collectImpacts(): { x: number; y: number; z: number; speed: number }[] {
    const out: { x: number; y: number; z: number; speed: number }[] = [];
    const threshold = BALANCE.physics.impactSpeedThreshold;
    for (const t of this.bodies.values()) {
      if (t.body.isSleeping()) {
        t.prevSpeed = 0;
        continue;
      }
      const v = t.body.linvel();
      const speed = Math.hypot(v.x, v.y, v.z);
      const drop = t.prevSpeed - speed;
      if (drop > threshold) {
        const p = t.body.translation();
        out.push({ x: p.x, y: p.y, z: p.z, speed: drop });
      }
      t.prevSpeed = speed;
    }
    return out;
  }

  /** 盤面をリセットする（リトライ時）。静的形状とプッシャーは残す。 */
  clearDynamic(): void {
    for (const t of [...this.bodies.values()]) this.remove(t);
  }

  /** 指定点から半径内にあるストーンの数を数える（ロウリュ用）。XZ 平面での距離。 */
  countStonesNear(x: number, z: number, radius: number): number {
    const r2 = radius * radius;
    let n = 0;
    for (const t of this.bodies.values()) {
      if (t.kind !== 'stone') continue;
      const p = t.body.translation();
      const dx = p.x - x;
      const dz = p.z - z;
      if (dx * dx + dz * dz <= r2) n += 1;
    }
    return n;
  }
}
