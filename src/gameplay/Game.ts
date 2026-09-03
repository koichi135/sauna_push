import * as THREE from 'three';
import { BALANCE } from '../core/BalanceConfig';
import { EventBus } from '../core/EventBus';
import { GameLoop } from '../core/GameLoop';
import { StateMachine, type GameState } from '../core/StateMachine';
import { PhysicsWorld, type TrackedBody } from '../physics/PhysicsWorld';
import { AudioEngine } from '../audio/AudioEngine';
import { buildItemMesh, buildScene, type SceneRefs } from '../view/SceneBuilder';
import { CameraRig } from '../view/CameraRig';
import { DistortionPass, SplashEffect, SteamSystem } from '../view/Effects';
import { QualityScaler } from '../view/QualityScaler';
import { HUD, type PopupKind } from '../ui/HUD';
import { Overlays } from '../ui/Overlays';
import { DebugPanel, isDebugEnabled } from '../ui/DebugPanel';
import { Gauges } from './Gauges';
import { Payout, loadHighScore, saveHighScore } from './Payout';
import { Pusher } from './Pusher';
import { StoneSpawner } from './StoneSpawner';
import { FeverController, feverParamsFor } from './FeverController';
import { LoylyController } from './Loyly';
import { ItemSystem, itemDef, type ItemId } from './ItemSystem';
import type { GameContext } from './GameContext';
import { RunModifiers } from './RunModifiers';
import { draftPerks, type PerkDef } from './Perks';

/**
 * ゲーム全体の組み立て（仕様 11章の状態機械が中心）。
 *
 * 更新は必ず二段構え:
 *   fixedUpdate — 物理とゲームロジック。固定ステップでのみ進む
 *   render      — 描画と UI。可変フレーム時間で良い
 * 物理をレンダーフレーム時間で進めないこと（仕様 2章 禁止事項）。
 */
export class Game implements GameContext {
  readonly bus = new EventBus();
  readonly gauges: Gauges;

  private readonly renderer: THREE.WebGLRenderer;
  private readonly refs: SceneRefs;
  private readonly cameraRig: CameraRig;
  private readonly steam = new SteamSystem();
  private readonly splash = new SplashEffect();
  private readonly distortion: DistortionPass;
  private readonly quality: QualityScaler;

  private readonly physics: PhysicsWorld;
  private readonly pusher: Pusher;
  private readonly spawner: StoneSpawner;
  private readonly payout: Payout;
  private readonly fever = new FeverController();
  private readonly loyly = new LoylyController();
  private readonly items: ItemSystem;

  private readonly machine = new StateMachine();
  private readonly loop: GameLoop;
  private readonly audio = new AudioEngine();
  private readonly hud = new HUD();
  private readonly overlays: Overlays;
  private readonly debugPanel: DebugPanel | null;

  /** アイテムの TrackedBody id → 3Dメッシュ */
  private readonly itemMeshes = new Map<number, THREE.Mesh>();
  /** ロウリュモードに入る直前の状態。PLAYING か FEVER */
  private aimReturnState: GameState = 'PLAYING';
  /** 濡れているストーンの位置。蒸気の発生源として毎フレーム集める */
  private wetSources: { x: number; y: number; z: number }[] = [];
  private highScore = loadHighScore();
  private hasSeenTutorial = false;
  private gameOverDelay = 0;
  /** 水風呂の歪み演出の強さ 0..1 */
  private waterAmount = 0;
  /** このランの経過秒数（時間切れタイムアタックの判定・難度上昇に使う） */
  private runSec = 0;
  /** ラン終了が時間切れクリアか体力切れ失敗か。RESULT 表示に使う */
  private runCleared = false;
  /** パーク選択（Perks.ts）で積み上がる、このラン限りの永続倍率・加算値 */
  private readonly mods = new RunModifiers();
  /** 現在パーク選択画面に出している 3 択 */
  private pendingPerks: readonly PerkDef[] = [];
  /** 固定ステップで発生し、次の描画で画面座標へ投影して出すスコア表示 */
  private readonly pendingPopups: {
    x: number;
    y: number;
    z: number;
    text: string;
    kind: PopupKind;
    /** ペイアウト額なら数値。HUD 側で直前の表示に積み上げる */
    amount?: number;
  }[] = [];
  private readonly tmpProject = new THREE.Vector3();

  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3(1, 1, 1);
  private readonly tmpColor = new THREE.Color();
  private readonly raycaster = new THREE.Raycaster();
  private readonly boardPlane = new THREE.Plane(
    new THREE.Vector3(0, 1, 0),
    -BALANCE.field.lowerTableY,
  );

  constructor(canvas: HTMLCanvasElement) {
    this.gauges = new Gauges(this.bus);
    this.payout = new Payout(this.bus);
    this.quality = new QualityScaler(this.bus);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
    });
    // モバイルの高DPIで素直に devicePixelRatio を使うと 30fps を割るため 2 で頭打ち
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.refs = buildScene();
    this.refs.scene.add(this.steam.points);
    this.refs.scene.add(this.splash.group);
    this.cameraRig = new CameraRig(window.innerWidth / window.innerHeight);
    this.distortion = new DistortionPass(window.innerWidth, window.innerHeight);

    this.physics = new PhysicsWorld();
    this.pusher = new Pusher(this.physics);
    this.spawner = new StoneSpawner(this.physics);
    this.items = new ItemSystem(this.physics);
    this.prefillBoard();

    this.overlays = new Overlays({
      onStart: () => this.startFromTitle(),
      onOpenTutorial: () => this.overlays.show('tutorial'),
      onCloseTutorial: () => this.beginPlaying(),
      onRetry: () => this.retry(),
      onToTitle: () => this.goToTitle(),
      onResume: () => this.resumeFromPause(),
      onToggleMute: () => {
        this.audio.setMuted(!this.audio.isMuted);
        return this.audio.isMuted;
      },
    });
    this.overlays.setHighScore(this.highScore);

    this.debugPanel = isDebugEnabled() ? new DebugPanel(this.debugActions()) : null;
    if (isDebugEnabled()) this.exposeTestHarness();

    this.loop = new GameLoop({
      fixedUpdate: (dt) => this.fixedUpdate(dt),
      render: (frameDt) => this.render(frameDt),
    });

    this.bindEvents();
    this.bindInput();

    this.machine.transition('TITLE');
    this.overlays.show('title');
    this.hud.setVisible(false);
    this.loop.start();
  }

  // ================================================================ 入力

  /**
   * 全操作シングルタップ（仕様 9章）。
   * ドラッグ・ピンチ・長押しは使わないので pointerdown だけを見る。
   */
  private bindInput(): void {
    // 投入レーン: タップした X 位置から投入
    this.hud.throwLaneElement.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      void this.audio.unlock();
      const rect = this.hud.throwLaneElement.getBoundingClientRect();
      const normalized = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
      this.tryThrow(normalized);
    });

    this.hud.coldBathButton.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      void this.audio.unlock();
      this.enterColdBath(false);
    });

    // ロウリュ: 押すとロウリュモードに入る。クールタイム中は反応しない
    this.hud.loylyButton.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      void this.audio.unlock();
      this.toggleLoylyMode();
    });

    // 盤面タップ: ロウリュモードのときだけ意味を持つ（水をかける）
    this.renderer.domElement.addEventListener('pointerdown', (ev) => {
      void this.audio.unlock();
      if (this.machine.state !== 'AIMING') return;
      if (this.isInDeadZone(ev.clientX, ev.clientY)) return;
      this.pourWaterAtScreen(ev.clientX, ev.clientY);
    });

    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('orientationchange', () => this.onResize());

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.pauseForVisibility();
      else if (this.machine.isPaused) this.overlays.show('paused');
    });
  }

  /**
   * HUD 要素の下 8px に不感帯を設ける（仕様 9章）。
   * 投入レーンや水風呂ボタンのすぐ脇を狙ってロウリュを撃とうとしたときの誤爆を防ぐ。
   */
  private isInDeadZone(x: number, y: number): boolean {
    const pad = BALANCE.input.deadZonePx;
    const targets = [this.hud.throwLaneElement, this.hud.coldBathButton, this.hud.loylyButton];
    for (const node of targets) {
      if (node.hidden) continue;
      const r = node.getBoundingClientRect();
      if (r.width === 0) continue;
      if (x >= r.left - pad && x <= r.right + pad && y >= r.top - pad && y <= r.bottom + pad) {
        return true;
      }
    }
    return false;
  }

  private tryThrow(normalizedX: number): void {
    if (this.machine.inputBlocked) return;
    if (this.machine.state === 'AIMING') return;
    const fever = this.fever.isFever;
    if (!this.payout.canThrow(fever)) return;
    // 画面座標の左右と world の X は向きが逆（BalanceConfig の screenToWorldXSign 参照）。
    // ここで符号を合わせないと、タップした側と反対側にストーンが落ちる。
    const worldX = normalizedX * BALANCE.spawn.screenToWorldXSign;
    const stone = this.spawner.tryThrow(
      worldX,
      this.loop.now,
      fever,
      this.payout.nextThrowIsBig,
      this.payout.bigStoneValueBonus,
    );
    if (!stone) return;
    const usedBig = this.payout.consumeForThrow(fever);
    if (usedBig) {
      this.hud.toast('大玉ストーン投入！', 'good');
      this.cameraRig.shake(0.01);
    }
    // レーンのフィードバックはタップした画面位置に出す（符号を戻さない）
    this.hud.flashThrowLane(normalizedX);
    this.bus.emit('STONE_THROWN', { x: stone.body.translation().x });
  }

  /**
   * 盤面に初期山を積む（BALANCE.field.prefill）。
   * 実機のコインプッシャー同様、最初から山がある状態で始めないと
   * 「投げても何も落ちない」時間が長すぎて手持ちが尽きる。
   * 静止状態で置いてから物理を回して落ち着かせる。センサーに落ちた分は数えない。
   */
  private prefillBoard(): void {
    const f = BALANCE.field;
    const pf = f.prefill;
    const s = BALANCE.physics.stone;
    const p = BALANCE.pusher;
    const pitch = s.radius * 2 * 1.06;
    const jitter = () => (Math.random() - 0.5) * 0.006;

    // 下段テーブル: ペイアウト境界の少し内側から、最後退時のプッシャー前面の手前まで。
    // 板と重なる位置に置くと弾き飛ばされるので、前面より 1 個ぶん手前で止める。
    const pusherFrontRetracted = p.baseZ - p.depth / 2;
    const lowerFront = f.payoutZ + s.radius + 0.012;
    const lowerBack = pusherFrontRetracted - s.radius - 0.005;
    const lowerStep = pf.lowerRows > 1 ? (lowerBack - lowerFront) / (pf.lowerRows - 1) : 0;
    for (let layer = 0; layer < pf.lowerLayers; layer += 1) {
      for (let row = 0; row < pf.lowerRows; row += 1) {
        const z = lowerFront + lowerStep * row;
        // 段ごとに半個ずらして噛み合わせる
        const offset = ((layer + row) % 2) * pitch * 0.5;
        for (let col = 0; col < pf.lowerCols; col += 1) {
          const x = -f.halfWidth + s.radius + 0.004 + col * pitch + offset;
          if (x > f.halfWidth - s.radius) continue;
          const y = f.lowerTableY + s.thickness + 0.004 + layer * (s.thickness + 0.006);
          this.physics.placeStone(x + jitter(), y, z + jitter());
        }
      }
    }

    // プッシャー板の上: 前面の少し内側から、シュート前縁の手前まで
    const shelfFront = pusherFrontRetracted + s.radius + 0.01;
    const shelfBack = f.chute.frontZ - s.radius - 0.01;
    const shelfStep = pf.shelfRows > 1 ? (shelfBack - shelfFront) / (pf.shelfRows - 1) : 0;
    for (let row = 0; row < pf.shelfRows; row += 1) {
      const z = shelfFront + shelfStep * row;
      const offset = (row % 2) * pitch * 0.5;
      for (let col = 0; col < pf.shelfCols; col += 1) {
        const x = -f.halfWidth + s.radius + 0.004 + col * pitch + offset;
        if (x > f.halfWidth - s.radius) continue;
        this.physics.placeStone(x + jitter(), f.shelfTopY + s.thickness + 0.004, z + jitter());
      }
    }

    this.physics.settle(pf.settleSteps);

    // プッシャーを空回しして定常状態にする。周期ちょうどで止めるので位相は 0 に戻る
    const dt = BALANCE.physics.fixedTimeStep;
    const warmupSteps = Math.round((BALANCE.pusher.period * pf.warmupCycles) / dt);
    for (let i = 0; i < warmupSteps; i += 1) {
      this.pusher.update(dt, false);
      this.physics.settle(1);
    }
  }

  /** ロウリュボタン。押すとモードに入り、モード中に押すと取り消す */
  private toggleLoylyMode(): void {
    if (this.machine.state === 'AIMING') {
      this.loyly.cancel();
      this.endAiming();
      return;
    }
    if (this.machine.inputBlocked) return;
    const from = this.machine.state;
    if (from !== 'PLAYING' && from !== 'FEVER') return;
    if (!this.loyly.tryActivate()) return;

    this.aimReturnState = from;
    if (this.machine.transition('AIMING')) {
      this.hud.setAiming(true, 1);
      this.hud.toast('水をかける場所をタップ');
    } else {
      this.loyly.cancel();
    }
  }

  /** タップ位置を盤面平面へ投影して、そこに水をかける */
  private pourWaterAtScreen(clientX: number, clientY: number): void {
    const ndc = new THREE.Vector2(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.cameraRig.camera);
    const hit = new THREE.Vector3();
    // レイキャストは画面座標をそのまま world に写すので、投入レーンと違い符号の補正は要らない
    if (!this.raycaster.ray.intersectPlane(this.boardPlane, hit)) {
      this.pourWater(0, 0);
      return;
    }
    const f = BALANCE.field;
    this.pourWater(
      THREE.MathUtils.clamp(hit.x, -f.halfWidth, f.halfWidth),
      THREE.MathUtils.clamp(hit.z, f.payoutZ, f.backZ),
    );
  }

  /**
   * 水をかける。狙った地点の半径内のストーンへ即座に衝撃を与えて手前へ押し出す
   * （山をほぐす攻略ツール。README「ロウリュの再設計」参照）。
   * 押し出されたストーンはコンボ窓に乗るので、詰まった山をコンボに変換できる。
   * 副次効果として軽く濡れて温度も少し上がる（updateWetness で進む）。
   */
  private pourWater(x: number, z: number): void {
    const l = BALANCE.loyly;
    const radius = l.radius * this.mods.loylyRadiusMult;
    const pushed = this.physics.pushStonesNear(x, z, radius, l.pushVelocity, l.liftVelocity);
    this.physics.wetStonesNear(x, z, radius, l.wetDurationSec);

    this.loyly.consume();
    this.splash.play(x, BALANCE.field.lowerTableY + 0.01, z);
    this.steam.burst(x, z);
    this.hud.playFlash('loyly');
    this.hud.toast(pushed > 0 ? `ロウリュ！ ${pushed} 個を押し出した` : 'ロウリュ（空振り）');
    this.cameraRig.shake(0.03);
    this.audio.playLoyly();
    this.bus.emit('LOYLY_FIRED', { x, z, stones: pushed, deltaTemp: 0 });
    this.endAiming();
  }

  private endAiming(): void {
    if (this.machine.state !== 'AIMING') return;
    this.hud.setAiming(false);
    this.machine.transition(this.aimReturnState);
  }

  // ================================================================ GameContext

  healStamina(amount: number): void {
    this.gauges.addStamina(amount);
    this.hud.toast(`オロポ 体力 +${amount}`);
    this.audio.playOropo();
  }

  slowMotion(scale: number, durationSec: number): void {
    this.loop.setSlowMotion(scale, durationSec);
  }

  pushAllStones(velocityZ: number, liftY: number): void {
    const n = this.physics.pushAllStones(velocityZ, liftY);
    this.hud.toast(`ヴィヒタ！ ${n} 個を扇いだ`, 'good');
    this.cameraRig.shake(0.02);
    this.audio.playVihta();
  }

  addPermanentComboWindow(seconds: number): void {
    this.payout.addRelicComboWindow(seconds);
    this.hud.toast('ヴィヒタのお守り 連鎖猶予アップ（永続）', 'good');
    this.audio.playVihta();
  }

  addPermanentDamageResist(mult: number): void {
    this.gauges.addRelicDamageResist(mult);
    this.hud.toast(`サウナハット 耐熱グレード ${this.gauges.relicDamageStacks} 段（永続）`, 'good');
    this.audio.playHat();
  }

  addPermanentFeverDuration(seconds: number): void {
    this.fever.relicDurationBonusSec += seconds;
    this.hud.toast(`砂時計 外気浴 +${seconds.toFixed(0)}秒 蓄積（永続）`, 'good');
    this.audio.playHourglass();
  }

  // ================================================================ 固定ステップ

  private fixedUpdate(dt: number): void {
    if (this.machine.isPaused) return;

    // 入水演出中はプッシャーを止める（仕様 7.1）
    this.pusher.setStopped(this.fever.isColdBath);
    this.pusher.update(dt, this.fever.isFever);

    // 物理は状態に関わらず進める。COLD_BATH / GAME_OVER でも見た目の連続性を保つ（仕様 11章）
    const { payouts, losts, impacts } = this.physics.step();
    this.handleSensorHits(payouts, losts);
    this.handleImpacts(impacts);

    const culled = this.physics.cullExcess();
    if (culled > 0) this.bus.emit('STONE_CULLED', { count: culled });

    // タイムアタックの時計は PERK_DRAFT（考える時間）だけ止める。COLD_BATH の演出は含める
    if (this.machine.gaugesRunning || this.machine.state === 'COLD_BATH') {
      this.runSec += dt;
      this.updateDifficulty();
    }

    if (this.machine.gaugesRunning) {
      this.gauges.update(dt, this.loop.now, {
        starving: this.payout.isStarving,
        fever: this.fever.isFever,
      });
      this.payout.update(this.loop.now);
      this.updateItems(dt);
      this.updateLoyly(dt);
      this.updateWetness(dt);
      this.checkAutoColdBath();
    }

    this.updateFever(dt);
    this.checkRunEnd(dt);
  }

  private handleSensorHits(payouts: TrackedBody[], losts: TrackedBody[]): void {
    let paidStones = 0;
    let bigPaid = 0;
    let sumX = 0;
    const collectedItems: ItemId[] = [];
    // タイトル画面やゲームオーバー中も物理は動くが、そこで落ちた分はスコアにしない
    const scoring = this.machine.gaugesRunning;

    for (const tracked of payouts) {
      const pos = tracked.body.translation();
      if (tracked.kind === 'stone') {
        if (scoring) {
          paidStones += tracked.value;
          sumX += pos.x * tracked.value;
          if (tracked.big) {
            bigPaid += 1;
            this.bus.emit('BIG_STONE_PAID', { x: pos.x, z: pos.z });
          }
          this.bus.emit('STONE_PAID', { x: pos.x, z: pos.z, count: tracked.value });
        }
      } else if (!scoring) {
        this.items.notifyRemoved(tracked);
        this.removeItemMesh(tracked.id);
      } else if (tracked.itemId) {
        // アイテムはペイアウト口に落ちたときのみ発動（仕様 8章）
        collectedItems.push(tracked.itemId as ItemId);
        this.items.notifyRemoved(tracked);
        this.removeItemMesh(tracked.id);
      }
      this.physics.remove(tracked);
    }

    for (const tracked of losts) {
      const pos = tracked.body.translation();
      if (tracked.kind === 'stone') {
        this.bus.emit('STONE_LOST', { x: pos.x, z: pos.z });
      } else {
        // ロスト溝のアイテムは効果なしで消滅（仕様 8章）
        this.items.notifyRemoved(tracked);
        this.removeItemMesh(tracked.id);
      }
      this.physics.remove(tracked);
    }

    if (paidStones > 0) {
      const result = this.payout.registerPayout(paidStones, this.fever.multiplier, this.loop.now);
      this.gauges.registerPayout(this.loop.now, paidStones);
      this.items.registerPayout(paidStones);
      // 連鎖が伸びるほど音程が上がる
      const comboPitch = 1 + Math.min(result.combo, 20) * 0.03;
      this.audio.playPayout((this.fever.isFever ? 1.25 : 1) * comboPitch);
      this.hud.bumpScore();

      const f = BALANCE.field;
      const kind: PopupKind = bigPaid > 0 ? 'big' : result.combo >= BALANCE.combo.milestoneEvery ? 'combo' : 'normal';
      this.pendingPopups.push({
        x: sumX / paidStones,
        y: f.lowerTableY,
        z: f.payoutZ - 0.02,
        text: `+${result.amount}`,
        kind,
        amount: result.amount,
      });

      if (result.bonusStones > 0) {
        this.hud.toast(`${result.combo} 連鎖！ ストーン +${result.bonusStones}`, 'good');
        this.audio.playComboMilestone(Math.floor(result.combo / BALANCE.combo.milestoneEvery));
        this.pendingPopups.push({
          x: sumX / paidStones,
          y: f.lowerTableY + 0.04,
          z: f.payoutZ,
          text: `🪨 +${result.bonusStones}`,
          kind: 'bonus',
        });
      }
      if (result.earnedBigStone) {
        this.hud.toast('大玉ストーン獲得！ 次の投入で使える', 'good');
        this.audio.playBigStoneEarned();
      }
      if (bigPaid > 0) {
        this.cameraRig.shake(0.025);
        this.audio.playBigStonePaid();
      }
    }

    // 効果の発動は盤面の後始末が終わってから。onPayout が状態遷移を起こすため。
    for (const id of collectedItems) {
      const def = itemDef(id);
      this.bus.emit('ITEM_COLLECTED', { id });
      def.onPayout(this);
    }
  }

  private handleImpacts(impacts: { x: number; y: number; z: number; speed: number }[]): void {
    if (impacts.length === 0) return;
    // 同時発音数は AudioEngine 側で制限されるが、強い順に渡して重要な音を優先する
    impacts.sort((a, b) => b.speed - a.speed);
    const limit = Math.min(impacts.length, BALANCE.audio.maxImpactVoices);
    for (let i = 0; i < limit; i += 1) {
      const impact = impacts[i];
      if (!impact) continue;
      this.audio.playImpact(Math.min(1, impact.speed / 2));
      this.bus.emit('STONE_IMPACT', impact);
    }
  }

  private updateItems(dt: number): void {
    const spawned = this.items.update(dt);
    if (spawned === null) return;
    this.attachItemMeshes();
    this.hud.toast(`${itemDef(spawned).label} 出現`);
    this.bus.emit('ITEM_SPAWNED', { id: spawned });
  }

  /** 物理側に増えたアイテムに 3D メッシュを付ける */
  private attachItemMeshes(): void {
    for (const tracked of this.physics.all()) {
      if (tracked.kind !== 'item' || this.itemMeshes.has(tracked.id)) continue;
      const def = itemDef(tracked.itemId as ItemId);
      const mesh = buildItemMesh(def.color, def.modelKey);
      this.itemMeshes.set(tracked.id, mesh);
      this.refs.itemGroup.add(mesh);
    }
  }

  private removeItemMesh(id: number): void {
    const mesh = this.itemMeshes.get(id);
    if (!mesh) return;
    this.refs.itemGroup.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    this.itemMeshes.delete(id);
  }

  private updateLoyly(dt: number): void {
    const result = this.loyly.update(dt);
    if (this.machine.state === 'AIMING') {
      this.hud.setAiming(true, this.loyly.modeRatio);
    }
    // モードのまま放置したら解除する。クールタイムは消費しない
    if (result === 'timeout') this.endAiming();
  }

  /**
   * 濡れているストーンを進める。
   * 濡れている間だけ室温が上がる（かけた瞬間に跳ねるのではない）ので、
   * 「何個濡らせたか」がそのまま効きの差になる。
   */
  private updateWetness(dt: number): void {
    const wetCount = this.physics.tickWetness(dt);
    if (wetCount === 0) return;
    const l = BALANCE.loyly;
    this.gauges.addTemperature(Math.min(wetCount, l.maxStones) * l.tempPerStonePerSec * dt);
  }

  // ================================================================ 水風呂・フィーバー

  private checkAutoColdBath(): void {
    if (this.fever.currentPhase !== 'idle') return;
    if (!this.gauges.isTotonoiReady) return;
    // MAX のまま放置すると自動で水風呂へ（倍率ボーナスなし。仕様 6.2 / 7.1）
    if (this.gauges.totonoiFullSec >= BALANCE.totonoi.autoColdBathSec) {
      this.enterColdBath(true);
    }
  }

  private enterColdBath(auto: boolean): void {
    if (this.fever.currentPhase !== 'idle') return;
    if (!this.gauges.isTotonoiReady) return;
    if (this.machine.state === 'AIMING') this.endAiming();
    if (!this.machine.transition('COLD_BATH')) return;

    // パーク「長湯」による継続時間の加算は手動入水のみ効く（自動入水はボーナス無し）
    const params = this.fever.enterColdBath(
      this.gauges.temperature,
      auto,
      auto ? 0 : this.mods.feverDurationBonusSec,
    );
    this.cameraRig.setShot('coldBath');
    this.hud.playFlash('water');
    this.hud.setAiming(false);
    this.audio.playColdBath();
    this.bus.emit('COLD_BATH_ENTERED', {
      temperature: this.gauges.temperature,
      multiplier: params.multiplier,
      duration: params.duration,
      auto,
    });
    this.hud.toast(auto ? 'のぼせる前に自動入水…' : `入水！ ×${params.multiplier.toFixed(1)}`, auto ? 'bad' : 'good');
  }

  private updateFever(dt: number): void {
    // パーク選択中はフィーバーの内部タイマーを凍結する。
    // coldBath → fever の内部遷移は既に済んでいるが、選択中は timer=0 のまま止めておき、
    // 考える時間ぶん外気浴の残り時間を消費させないようにする。
    const phase = this.machine.state === 'PERK_DRAFT' ? 'none' : this.fever.update(dt);

    if (phase === 'feverStart') {
      // 入水後、温度は 5 まで低下（仕様 7.1）
      this.gauges.applyColdBath();
      const p = this.fever.pendingParams;
      if (this.fever.enteredAutomatically) {
        // 放置による自動入水: ボーナスなし・セットに数えない・短い外気浴。パーク選択も挟まない
        this.hud.toast(`ぬるい外気浴… ${p.duration.toFixed(0)}秒（ボーナスなし）`, 'bad');
        this.enterFeverState(p);
      } else {
        const bonus = this.payout.registerTotonoi(p.multiplier);
        this.updateDifficulty();
        this.hud.toast(`ととのった！ ×${p.multiplier.toFixed(1)} / ${p.duration.toFixed(1)}秒  +${bonus}`, 'good');
        this.startPerkDraft();
      }
    } else if (phase === 'feverEnd') {
      this.gauges.resetTotonoi();
      if (this.machine.state === 'AIMING') this.endAiming();
      this.machine.transition('PLAYING');
      this.cameraRig.setShot('play');
      this.audio.setFeverMusic(false);
      this.setOutdoorMood(false);
      this.bus.emit('FEVER_ENDED', {});
    }

    // 水風呂〜フィーバー序盤の水面歪みを時間で減衰させる
    const targetWater = this.fever.isColdBath ? 1 : 0;
    this.waterAmount += (targetWater - this.waterAmount) * Math.min(1, dt * 6);
  }

  /** COLD_BATH の内部遷移が済んだ後、実際に FEVER 状態へ入って演出を始める */
  private enterFeverState(p: { multiplier: number; duration: number }): void {
    this.machine.transition('FEVER');
    this.cameraRig.setShot('fever');
    this.audio.setFeverMusic(true);
    this.setOutdoorMood(true);
    this.bus.emit('FEVER_STARTED', { multiplier: p.multiplier, duration: p.duration });
  }

  // ================================================================ パーク選択

  /**
   * 手動入水のたびに 3 択のパークを提示する（FB「考える要素が欲しい」対応）。
   * 選ぶまでフィーバーのタイマーは凍結されているので、じっくり選んでよい。
   */
  private startPerkDraft(): void {
    if (!this.machine.transition('PERK_DRAFT')) {
      this.enterFeverState(this.fever.pendingParams);
      return;
    }
    this.pendingPerks = draftPerks(3);
    this.hud.showPerkDraft(
      this.pendingPerks.map((p) => ({ icon: p.icon, label: p.label, description: p.description })),
      (index) => this.pickPerk(index),
    );
  }

  private pickPerk(index: number): void {
    if (this.machine.state !== 'PERK_DRAFT') return;
    const perk = this.pendingPerks[index];
    if (!perk) return;

    perk.apply(this.mods);
    this.applyModsToSystems();
    this.hud.hidePerkDraft();
    this.pendingPerks = [];
    this.hud.toast(`${perk.icon} ${perk.label} を獲得！`, 'good');
    this.enterFeverState(this.fever.pendingParams);
  }

  /** mods に積んだパーク効果を各サブシステムへ反映する。パーク選択のたびに呼ぶ */
  private applyModsToSystems(): void {
    this.pusher.setStrokeMult(this.mods.pusherStrokeMult);
    this.spawner.setCooldownMult(this.mods.throwCooldownMult);
    this.loyly.setCooldownMult(this.mods.loylyCooldownMult);
    this.items.setSpawnRateMult(this.mods.itemSpawnRateMult);
    this.gauges.setRunModifiers(this.mods);
    this.payout.setRunModifiers(this.mods);
  }

  /** 難度レベル = セット数 + 経過分 × levelPerMinute（BALANCE.sets） */
  private updateDifficulty(): void {
    const level = this.payout.totonoiCount + (this.runSec / 60) * BALANCE.sets.levelPerMinute;
    this.gauges.setDifficulty(level);
  }

  /** 外気浴の「空が抜ける」画（仕様 7.2） */
  private setOutdoorMood(outdoor: boolean): void {
    const scene = this.refs.scene;
    const bg = scene.background as THREE.Color;
    if (outdoor) {
      bg.setHex(0x2c4f70);
      scene.fog = new THREE.Fog(0x3d6b8f, 1.1, 3.2);
      this.refs.ambient.color.setHex(0xbcd8ff);
      this.refs.ambient.intensity = 0.95;
      this.refs.roomLight.color.setHex(0xdff0ff);
      this.refs.wallMaterial.color.setHex(0x8fb6cf);
    } else {
      bg.setHex(0x1a0f0a);
      scene.fog = new THREE.Fog(0x2a180f, 0.9, 2.4);
      this.refs.ambient.color.setHex(0xffc79a);
      this.refs.ambient.intensity = 0.6;
      this.refs.roomLight.color.setHex(0xffd6a5);
      this.refs.wallMaterial.color.setHex(0xb98a5a);
    }
  }

  // ================================================================ ラン終了（時間切れクリア／体力切れゲームオーバー）

  /**
   * FB「目標が不明確」への対応。3分のタイムアタックにし、時間切れまで生き延びれば
   * クリア（生存ボーナス）、体力が尽きれば失敗、という明確な終わりを作った。
   * 判定は PLAYING / AIMING / FEVER のときだけ行う（COLD_BATH / PERK_DRAFT 中に
   * ちょうど時間切れになっても、演出やパーク選択の区切りが付いてから終える）。
   */
  private checkRunEnd(dt: number): void {
    if (this.machine.state === 'GAME_OVER') {
      // 少し見せてからリザルトへ
      this.gameOverDelay += dt;
      if (this.gameOverDelay >= 1.8) {
        this.gameOverDelay = 0;
        this.machine.transition('RESULT');
        this.overlays.showResult({
          score: this.payout.score,
          totonoiCount: this.payout.totonoiCount,
          totalPaid: this.payout.totalPaid,
          maxCombo: this.payout.maxCombo,
          bestMultiplier: this.payout.bestMultiplier,
          highScore: this.highScore,
          isHighScore: this.payout.score >= this.highScore && this.payout.score > 0,
          cleared: this.runCleared,
        });
        this.hud.setVisible(false);
      }
      return;
    }

    const judgeable =
      this.machine.state === 'PLAYING' || this.machine.state === 'AIMING' || this.machine.state === 'FEVER';
    if (!judgeable) return;

    if (this.gauges.isDead) {
      this.endRun(false);
      return;
    }
    if (this.runSec >= BALANCE.run.durationSec) {
      this.endRun(true);
    }
  }

  /** @param cleared タイムアタックを時間切れまで生き延びたか。false は体力切れ */
  private endRun(cleared: boolean): void {
    if (this.machine.state === 'AIMING') this.endAiming();
    if (!this.machine.transition('GAME_OVER')) return;

    this.runCleared = cleared;
    if (cleared) {
      const ratio = this.gauges.stamina / this.gauges.maxStamina;
      const bonus = Math.round(BALANCE.run.survivalBonus * ratio);
      this.payout.addSurvivalBonus(bonus);
    }

    this.gameOverDelay = 0;
    const isHigh = this.payout.score > this.highScore;
    if (isHigh) {
      this.highScore = this.payout.score;
      saveHighScore(this.highScore);
      this.overlays.setHighScore(this.highScore);
    }
    this.cameraRig.setShot('gameOver');
    this.cameraRig.shake(0.05);
    this.audio.setFeverMusic(false);
    if (cleared) this.audio.playRunClear();
    else this.audio.playGameOver();
    this.hud.toast(cleared ? 'タイムアップ！ クリア！' : 'のぼせました…', cleared ? 'good' : 'bad');
    this.bus.emit('GAME_OVER', {
      score: this.payout.score,
      totonoiCount: this.payout.totonoiCount,
      isHighScore: isHigh,
    });
  }

  // ================================================================ 描画

  private render(frameDt: number): void {
    this.quality.update(frameDt, this.loop.fps);
    this.syncStones();
    this.syncItems();
    this.syncPusher();
    this.updateVisuals(frameDt);
    this.cameraRig.update(frameDt);

    const heat = Math.max(0, (this.gauges.temperature - 70) / 30);
    const useDistortion =
      this.quality.allowDistortion && (heat > 0.02 || this.waterAmount > 0.02);

    if (useDistortion) {
      this.distortion.set(this.loop.now, heat, this.waterAmount);
      this.renderer.setRenderTarget(this.distortion.target);
      this.renderer.render(this.refs.scene, this.cameraRig.camera);
      this.distortion.render(this.renderer);
    } else {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.refs.scene, this.cameraRig.camera);
    }

    this.flushPopups();
    this.updateHud();
    this.debugPanel?.update(
      {
        fps: this.loop.fps,
        bodies: this.physics.bodyCount,
        quality: this.quality.currentStep,
        state: this.machine.state,
      },
      performance.now(),
    );
  }

  /** 固定ステップで溜まったスコア表示を、現在のカメラで画面座標に投影して出す */
  private flushPopups(): void {
    if (this.pendingPopups.length === 0) return;
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const popup of this.pendingPopups) {
      this.tmpProject.set(popup.x, popup.y, popup.z).project(this.cameraRig.camera);
      const sx = (this.tmpProject.x + 1) * 0.5 * w;
      const sy = (1 - this.tmpProject.y) * 0.5 * h;
      if (popup.amount !== undefined) this.hud.payoutPopup(sx, sy, popup.amount, popup.kind);
      else this.hud.popup(sx, sy, popup.text, popup.kind);
    }
    this.pendingPopups.length = 0;
  }

  /**
   * 物理の姿勢を InstancedMesh に流し込む。個別 Mesh では 120 個で破綻する。
   * あわせて、濡れているストーンだけインスタンス色を暗くし、
   * 蒸気の発生源リストを組み直す。
   */
  private syncStones(): void {
    const mesh = this.refs.stoneMesh;
    let index = 0;
    const max = mesh.instanceMatrix.count;
    this.wetSources.length = 0;
    const dark = 1 - BALANCE.loyly.wetDarkness;
    const big = BALANCE.bigStone;

    for (const tracked of this.physics.all()) {
      if (tracked.kind !== 'stone' || index >= max) continue;
      const t = tracked.body.translation();
      const r = tracked.body.rotation();
      this.tmpPos.set(t.x, t.y, t.z);
      this.tmpQuat.set(r.x, r.y, r.z, r.w);
      // 大玉はジオメトリ共有のままスケールで表す（円柱の軸は Y）
      if (tracked.big) this.tmpScale.set(big.radiusScale, big.thicknessScale, big.radiusScale);
      else this.tmpScale.set(1, 1, 1);
      this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
      mesh.setMatrixAt(index, this.tmpMatrix);

      if (tracked.wetRemaining > 0) {
        // 乾くにつれて元の色へ戻す
        const wetness = Math.min(1, tracked.wetRemaining / BALANCE.loyly.wetDurationSec);
        const shade = 1 - (1 - dark) * wetness;
        this.tmpColor.setRGB(shade, shade, shade);
        this.wetSources.push({ x: t.x, y: t.y, z: t.z });
      } else if (tracked.big) {
        // 大玉は赤みを帯びた「焼けた石」。ひと目で普通の石と区別できるように
        this.tmpColor.setRGB(1.6, 0.95, 0.7);
      } else {
        this.tmpColor.setRGB(1, 1, 1);
      }
      // 乾いているインスタンスにも必ず白を入れること。
      // instanceColor は 0 初期化なので、書かないと真っ黒なストーンが出る。
      mesh.setColorAt(index, this.tmpColor);

      index += 1;
    }
    mesh.count = index;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private syncItems(): void {
    for (const tracked of this.physics.all()) {
      if (tracked.kind !== 'item') continue;
      const mesh = this.itemMeshes.get(tracked.id);
      if (!mesh) continue;
      const t = tracked.body.translation();
      const r = tracked.body.rotation();
      mesh.position.set(t.x, t.y, t.z);
      mesh.quaternion.set(r.x, r.y, r.z, r.w);
    }
  }

  private syncPusher(): void {
    this.refs.pusherMesh.position.z = this.physics.getPusherZ();
  }

  private updateVisuals(frameDt: number): void {
    const temp = this.gauges.temperature;
    this.steam.update(frameDt, temp, this.quality.scale, this.wetSources);
    this.splash.update(frameDt);

    // ストーンの自発光を温度で強める（仕様 10章 3）。
    // 強くしすぎると盤面全体が橙に飽和して、石も木目も読めなくなる。
    const glow = Math.max(0, (temp - 55) / 45);
    this.refs.stoneMaterial.emissiveIntensity = glow * 0.3;

    // ストーブの炎と光源のちらつき（仕様 10章 5）
    const flicker = 0.85 + Math.sin(this.loop.now * 11) * 0.08 + Math.random() * 0.07;
    this.refs.stoveGlow.intensity = (0.25 + glow * 0.7) * flicker;
    const fireMat = this.refs.stoveFire.material as THREE.MeshBasicMaterial;
    fireMat.opacity = (0.18 + glow * 0.3) * flicker;

    // 低体力の心拍（仕様 6.3 / 10章）
    const ratio = this.gauges.stamina / BALANCE.stamina.max;
    const warning = ratio <= BALANCE.stamina.warningRatio && this.machine.gaugesRunning;
    this.audio.updateHeartbeat(
      frameDt,
      warning,
      warning ? 1 - ratio / BALANCE.stamina.warningRatio : 0,
    );
  }

  private updateHud(): void {
    const feverIdle = this.fever.currentPhase === 'idle';
    const pending = feverParamsFor(this.gauges.temperature);
    const coldBathReady = feverIdle && this.gauges.isTotonoiReady && !this.machine.inputBlocked;
    this.hud.update({
      gauges: this.gauges,
      payout: this.payout,
      fever: this.fever.isFever,
      feverMultiplier: this.fever.multiplier,
      feverRemaining: this.fever.remaining,
      feverProgress: this.fever.progress,
      coldBathReady,
      pendingMultiplier: pending.multiplier,
      // パーク「長湯」・砂時計レリックの加算ぶんも見せる（実際に入るのと同じ数字にする）
      pendingDuration: pending.duration + this.mods.feverDurationBonusSec + this.fever.relicDurationBonusSec,
      autoBathRatio: coldBathReady
        ? 1 - this.gauges.totonoiFullSec / BALANCE.totonoi.autoColdBathSec
        : 0,
      comboWindowRatio: this.payout.comboWindowRatio(this.loop.now),
      canThrow: this.payout.canThrow(this.fever.isFever) && !this.machine.inputBlocked,
      throwReady: this.spawner.isReady(this.loop.now, this.fever.isFever),
      loylyActive: this.machine.state === 'AIMING',
      loylyCooldownRatio: this.loyly.cooldownRatio,
      loylyCooldownSec: this.loyly.cooldownRemainingSec,
      runRemainingSec: BALANCE.run.durationSec - this.runSec,
    });
  }

  // ================================================================ 画面遷移

  private startFromTitle(): void {
    void this.audio.unlock();
    if (!this.hasSeenTutorial) {
      this.hasSeenTutorial = true;
      this.machine.transition('TUTORIAL');
      this.overlays.show('tutorial');
      return;
    }
    this.beginPlaying();
  }

  private beginPlaying(): void {
    void this.audio.unlock();
    if (this.machine.state === 'TITLE') this.machine.transition('TUTORIAL');
    this.machine.transition('PLAYING');
    this.resetRun();
    this.overlays.show(null);
    this.hud.setVisible(true);
    this.loop.resetTimeBase();
  }

  private retry(): void {
    this.machine.transition('TITLE');
    this.beginPlaying();
  }

  private goToTitle(): void {
    if (this.machine.state === 'RESULT') this.machine.transition('TITLE');
    this.resetRun();
    this.overlays.show('title');
    this.hud.setVisible(false);
    this.cameraRig.setShot('play');
  }

  private resetRun(): void {
    this.physics.clearDynamic();
    for (const id of [...this.itemMeshes.keys()]) this.removeItemMesh(id);
    this.pendingPopups.length = 0;
    this.gauges.reset();
    this.payout.reset();
    this.pusher.reset();
    this.prefillBoard();
    this.spawner.reset();
    this.items.reset();
    this.fever.reset();
    this.loyly.reset();
    this.wetSources.length = 0;
    this.hud.reset();
    this.hud.setAiming(false);
    this.audio.setFeverMusic(false);
    this.setOutdoorMood(false);
    this.cameraRig.setShot('play');
    this.gameOverDelay = 0;
    this.waterAmount = 0;
    this.runSec = 0;
    this.runCleared = false;
    this.mods.reset();
    this.pendingPerks = [];
  }

  /**
   * タブが隠れたら止める。復帰時に経過時間をゲージへ反映しないこと（仕様 11章）。
   */
  private pauseForVisibility(): void {
    if (!this.machine.pause()) return;
    this.audio.suspend();
    this.overlays.show('paused');
  }

  private resumeFromPause(): void {
    if (!this.machine.resume()) return;
    this.audio.resume();
    // 溜まった実時間を破棄してから再開する
    this.loop.resetTimeBase();
    this.overlays.show(null);
  }

  private onResize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h, false);
    this.cameraRig.setAspect(w / h);
    this.distortion.setSize(w, h);
  }

  private bindEvents(): void {
    this.bus.on('STONE_CULLED', ({ count }) => {
      console.debug(`[perf] 剛体上限で ${count} 個のストーンを間引きました`);
    });
    this.bus.on('QUALITY_CHANGED', ({ step }) => {
      console.debug(`[perf] 品質段階を ${step} に変更しました`);
    });
  }

  /**
   * `?debug=1` のときだけ生える調整用フック。
   *
   * 描画を挟まずに固定ステップだけを回せるようにしてある。実フレームレートに縛られず
   * 「ゲーム内で何分回すと何回ペイアウトするか」を測れるので、バランス調整と
   * 受け入れ基準（仕様 14章）の検証はこちらで行う。
   * 本番ビルドでも debug フラグが無ければ生成されない。
   */
  private exposeTestHarness(): void {
    const harness = {
      /** 描画抜きで固定ステップを n 回進める */
      step: (steps: number) => {
        for (let i = 0; i < steps; i += 1) this.loop.tickManually();
      },
      /** ゲーム内秒数で進める */
      advance: (seconds: number) => {
        harness.step(Math.round(seconds / BALANCE.physics.fixedTimeStep));
      },
      /** 投入レーンの normalizedX（画面座標基準、-1=左）を指定して投げる */
      throwAt: (normalizedX: number) => this.tryThrow(normalizedX),
      /** ロウリュモードに入り、盤面の (x, z) に水をかける */
      loylyAt: (x: number, z: number) => {
        this.toggleLoylyMode();
        this.pourWater(x, z);
      },
      /** ストーンの world X 分布。左右反転の検証用 */
      stoneXs: () => {
        const xs: number[] = [];
        for (const t of this.physics.all()) {
          if (t.kind === 'stone') xs.push(Number(t.body.translation().x.toFixed(3)));
        }
        return xs;
      },
      wetCount: () => {
        let n = 0;
        for (const t of this.physics.all()) if (t.wetRemaining > 0) n += 1;
        return n;
      },
      stats: () => ({
        state: this.machine.state,
        score: this.payout.score,
        stones: this.payout.stoneCount,
        paid: this.payout.totalPaid,
        totonoiCount: this.payout.totonoiCount,
        temperature: this.gauges.temperature,
        band: this.gauges.currentBand.id,
        totonoi: this.gauges.totonoi,
        stamina: this.gauges.stamina,
        bodies: this.physics.bodyCount,
        fever: this.fever.currentPhase,
        multiplier: this.fever.multiplier,
        combo: this.payout.combo,
        maxCombo: this.payout.maxCombo,
        bigCharges: this.payout.bigStoneCharges,
        relicShieldStacks: this.gauges.relicDamageStacks,
        coolingScale: this.gauges.coolingScale,
        damageScale: this.gauges.damageScaleValue,
        runRemainingSec: BALANCE.run.durationSec - this.runSec,
        cleared: this.runCleared,
        maxStamina: this.gauges.maxStamina,
        perksPending: this.pendingPerks.map((p) => p.id),
      }),
      addStones: (n: number) => {
        this.payout.stoneCount += n;
      },
      addBigStone: () => {
        this.payout.bigStoneCharges += 1;
      },
      setTemperature: (t: number) => {
        this.gauges.temperature = t;
      },
      setTotonoi: (v: number) => {
        this.gauges.totonoi = v;
      },
      /** 水風呂ボタン相当（ととのい MAX でなければ何もしない） */
      coldBath: () => this.enterColdBath(false),
      /** アイテム効果を直接発動する（盤面を経由しない） */
      useItem: (id: ItemId) => itemDef(id).onPayout(this),
      /** パーク選択画面が出ているとき、n 番目（0 始まり）を選ぶ */
      pickPerk: (index: number) => this.pickPerk(index),
      /** イベント購読。シナリオ計測でロスト数や大玉のペイアウトを数える */
      bus: this.bus,
      start: () => this.beginPlaying(),
      /** ストーンの分布を調べる。盤面のどこで詰まっているかの診断用 */
      dump: () => {
        const zs: number[] = [];
        const xs: number[] = [];
        const ys: number[] = [];
        let sleeping = 0;
        for (const t of this.physics.all()) {
          if (t.kind !== 'stone') continue;
          const p = t.body.translation();
          zs.push(p.z);
          xs.push(p.x);
          ys.push(p.y);
          if (t.body.isSleeping()) sleeping += 1;
        }
        const hist: Record<string, number> = {};
        for (const z of zs) {
          const bucket = (Math.floor(z / 0.05) * 0.05).toFixed(2);
          hist[bucket] = (hist[bucket] ?? 0) + 1;
        }
        return {
          count: zs.length,
          sleeping,
          minZ: Math.min(...zs),
          maxZ: Math.max(...zs),
          maxAbsX: Math.max(...xs.map(Math.abs)),
          maxY: Math.max(...ys),
          pusherZ: this.physics.getPusherZ(),
          pusherFrontZ: this.pusher.frontZ,
          zHistogram: hist,
        };
      },
    };
    (window as unknown as { __sauna: typeof harness }).__sauna = harness;
  }

  private debugActions() {
    return {
      addStones: (n: number) => {
        this.payout.stoneCount += n;
      },
      addBigStone: () => {
        this.payout.bigStoneCharges += 1;
      },
      setTemperature: (t: number) => {
        this.gauges.temperature = t;
      },
      forceColdBath: () => {
        this.gauges.totonoi = BALANCE.totonoi.max;
        this.enterColdBath(false);
      },
      spawnItem: () => {
        this.items.reset();
        // 次の update で確実に湧くよう、条件を満たすところまで時間を進める
        this.items.update(BALANCE.items.intervalSec + 1);
        this.attachItemMeshes();
      },
      killPlayer: () => {
        this.gauges.stamina = 0;
      },
      setQuality: (step: number) => {
        this.quality.setStep(step === 0 ? 0 : this.quality.currentStep + 1);
      },
    };
  }
}
