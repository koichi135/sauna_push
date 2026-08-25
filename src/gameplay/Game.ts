import * as THREE from 'three';
import { BALANCE } from '../core/BalanceConfig';
import { EventBus } from '../core/EventBus';
import { GameLoop } from '../core/GameLoop';
import { StateMachine, type GameState } from '../core/StateMachine';
import { PhysicsWorld, type TrackedBody } from '../physics/PhysicsWorld';
import { AudioEngine } from '../audio/AudioEngine';
import { buildItemMesh, buildScene, type SceneRefs } from '../view/SceneBuilder';
import { CameraRig } from '../view/CameraRig';
import { DistortionPass, SteamSystem } from '../view/Effects';
import { QualityScaler } from '../view/QualityScaler';
import { HUD } from '../ui/HUD';
import { Overlays } from '../ui/Overlays';
import { DebugPanel, isDebugEnabled } from '../ui/DebugPanel';
import { Gauges } from './Gauges';
import { Payout, loadHighScore, saveHighScore } from './Payout';
import { Pusher } from './Pusher';
import { StoneSpawner } from './StoneSpawner';
import { FeverController, feverParamsFor } from './FeverController';
import { ItemSystem, itemDef, type ItemId } from './ItemSystem';
import type { GameContext } from './GameContext';

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
  private readonly distortion: DistortionPass;
  private readonly quality: QualityScaler;

  private readonly physics: PhysicsWorld;
  private readonly pusher: Pusher;
  private readonly spawner: StoneSpawner;
  private readonly payout: Payout;
  private readonly fever = new FeverController();
  private readonly items: ItemSystem;

  private readonly machine = new StateMachine();
  private readonly loop: GameLoop;
  private readonly audio = new AudioEngine();
  private readonly hud = new HUD();
  private readonly overlays: Overlays;
  private readonly debugPanel: DebugPanel | null;

  /** アイテムの TrackedBody id → 3Dメッシュ */
  private readonly itemMeshes = new Map<number, THREE.Mesh>();
  /** 照準に入る直前の状態。PLAYING か FEVER */
  private aimReturnState: GameState = 'PLAYING';
  private aimTimer = 0;
  private highScore = loadHighScore();
  private hasSeenTutorial = false;
  private gameOverDelay = 0;
  /** 照準に入れない状態で取得したロウリュの持ち越し数 */
  private pendingLoyly = 0;
  /** 水風呂の歪み演出の強さ 0..1 */
  private waterAmount = 0;

  private readonly tmpMatrix = new THREE.Matrix4();
  private readonly tmpPos = new THREE.Vector3();
  private readonly tmpQuat = new THREE.Quaternion();
  private readonly tmpScale = new THREE.Vector3(1, 1, 1);
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
    this.cameraRig = new CameraRig(window.innerWidth / window.innerHeight);
    this.distortion = new DistortionPass(window.innerWidth, window.innerHeight);

    this.physics = new PhysicsWorld();
    this.pusher = new Pusher(this.physics);
    this.spawner = new StoneSpawner(this.physics);
    this.items = new ItemSystem(this.physics);

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

    // 盤面タップ: 照準モードのときだけ意味を持つ
    this.renderer.domElement.addEventListener('pointerdown', (ev) => {
      void this.audio.unlock();
      if (this.machine.state !== 'AIMING') return;
      if (this.isInDeadZone(ev.clientX, ev.clientY)) return;
      this.fireLoylyAtScreen(ev.clientX, ev.clientY);
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
    const targets = [this.hud.throwLaneElement, this.hud.coldBathButton];
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
    const stone = this.spawner.tryThrow(normalizedX, this.loop.now, fever);
    if (!stone) return;
    this.payout.consumeForThrow(fever);
    this.hud.flashThrowLane(normalizedX);
    this.bus.emit('STONE_THROWN', { x: stone.body.translation().x });
  }

  /** タップ位置を盤面平面へ投影してロウリュを撃つ（仕様 8.1） */
  private fireLoylyAtScreen(clientX: number, clientY: number): void {
    const ndc = new THREE.Vector2(
      (clientX / window.innerWidth) * 2 - 1,
      -(clientY / window.innerHeight) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.cameraRig.camera);
    const hit = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.boardPlane, hit)) {
      this.fireLoyly(0, 0);
      return;
    }
    const f = BALANCE.field;
    this.fireLoyly(
      THREE.MathUtils.clamp(hit.x, -f.halfWidth, f.halfWidth),
      THREE.MathUtils.clamp(hit.z, f.payoutZ, f.backZ),
    );
  }

  private fireLoyly(x: number, z: number): void {
    const { stones, deltaTemp } = this.items.fireLoyly(x, z);
    this.gauges.addTemperature(deltaTemp);
    this.steam.burst(x, z);
    this.hud.playFlash('loyly');
    this.hud.toast(`ロウリュ +${Math.round(deltaTemp)}℃`);
    this.cameraRig.shake(0.035);
    this.audio.playLoyly();
    this.bus.emit('LOYLY_FIRED', { x, z, stones, deltaTemp });
    this.endAiming();
  }

  private beginAimingInternal(): void {
    const from = this.machine.state;
    if (from !== 'PLAYING' && from !== 'FEVER') {
      // 入水演出中や照準中にもロウリュはペイアウトしうる。物理は状態に関わらず
      // 進んでいるため。ここで捨てると取ったのに何も起きないので、持ち越す。
      this.pendingLoyly += 1;
      return;
    }
    this.aimReturnState = from;
    this.aimTimer = 0;
    if (this.machine.transition('AIMING')) {
      this.hud.setAiming(true, 1);
    }
  }

  /** 持ち越したロウリュを、照準に入れる状態に戻ったところで消化する */
  private consumePendingLoyly(): void {
    if (this.pendingLoyly <= 0) return;
    const state = this.machine.state;
    if (state !== 'PLAYING' && state !== 'FEVER') return;
    this.pendingLoyly -= 1;
    this.beginAimingInternal();
  }

  private endAiming(): void {
    if (this.machine.state !== 'AIMING') return;
    this.hud.setAiming(false);
    this.machine.transition(this.aimReturnState);
  }

  // ================================================================ GameContext

  beginAiming(): void {
    this.beginAimingInternal();
  }

  healStamina(amount: number): void {
    this.gauges.addStamina(amount);
    this.hud.toast(`オロポ 体力 +${amount}`);
    this.audio.playOropo();
  }

  slowMotion(scale: number, durationSec: number): void {
    this.loop.setSlowMotion(scale, durationSec);
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

    if (this.machine.gaugesRunning) {
      this.gauges.update(dt, this.loop.now, {
        starving: this.payout.isStarving,
        fever: this.fever.isFever,
      });
      this.updateItems(dt);
      this.updateAiming(dt);
      this.consumePendingLoyly();
      this.checkAutoColdBath();
    }

    this.updateFever(dt);
    this.checkGameOver(dt);
  }

  private handleSensorHits(payouts: TrackedBody[], losts: TrackedBody[]): void {
    let paidStones = 0;
    const collectedItems: ItemId[] = [];

    for (const tracked of payouts) {
      const pos = tracked.body.translation();
      if (tracked.kind === 'stone') {
        paidStones += 1;
        this.bus.emit('STONE_PAID', { x: pos.x, z: pos.z, count: 1 });
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
      this.payout.registerPayout(paidStones, this.fever.multiplier);
      this.gauges.registerPayout(this.loop.now, paidStones);
      this.items.registerPayout(paidStones);
      this.audio.playPayout(this.fever.isFever ? 1.25 : 1);
      this.hud.bumpScore();
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

  private updateAiming(dt: number): void {
    if (this.machine.state !== 'AIMING') return;
    this.aimTimer += dt;
    const limit = BALANCE.items.loyly.aimTimeoutSec;
    this.hud.setAiming(true, 1 - this.aimTimer / limit);
    // 5秒以内にタップしない場合は中央に自動着弾（仕様 8.1）
    if (this.aimTimer >= limit) this.fireLoyly(0, 0);
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

    const params = this.fever.enterColdBath(this.gauges.temperature, auto);
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
    this.hud.toast(auto ? 'のぼせる前に自動入水…' : `入水！ ×${params.multiplier.toFixed(1)}`);
  }

  private updateFever(dt: number): void {
    const phase = this.fever.update(dt);

    if (phase === 'feverStart') {
      // 入水後、温度は 5 まで低下（仕様 7.1）
      this.gauges.applyColdBath();
      this.payout.registerTotonoi();
      this.machine.transition('FEVER');
      this.cameraRig.setShot('fever');
      this.audio.setFeverMusic(true);
      this.setOutdoorMood(true);
      const p = this.fever.pendingParams;
      this.hud.toast(`ととのった！ ×${p.multiplier.toFixed(1)} / ${p.duration.toFixed(1)}秒`);
      this.bus.emit('FEVER_STARTED', { multiplier: p.multiplier, duration: p.duration });
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

  // ================================================================ ゲームオーバー

  private checkGameOver(dt: number): void {
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
          highScore: this.highScore,
          isHighScore: this.payout.score >= this.highScore && this.payout.score > 0,
        });
        this.hud.setVisible(false);
      }
      return;
    }

    if (!this.machine.gaugesRunning || !this.gauges.isDead) return;

    if (this.machine.state === 'AIMING') this.endAiming();
    if (!this.machine.transition('GAME_OVER')) return;

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
    this.audio.playGameOver();
    this.hud.toast('のぼせました…');
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

  /** 物理の姿勢を InstancedMesh に流し込む。個別 Mesh では 120 個で破綻する。 */
  private syncStones(): void {
    const mesh = this.refs.stoneMesh;
    let index = 0;
    const max = mesh.instanceMatrix.count;
    for (const tracked of this.physics.all()) {
      if (tracked.kind !== 'stone' || index >= max) continue;
      const t = tracked.body.translation();
      const r = tracked.body.rotation();
      this.tmpPos.set(t.x, t.y, t.z);
      this.tmpQuat.set(r.x, r.y, r.z, r.w);
      this.tmpMatrix.compose(this.tmpPos, this.tmpQuat, this.tmpScale);
      mesh.setMatrixAt(index, this.tmpMatrix);
      index += 1;
    }
    mesh.count = index;
    mesh.instanceMatrix.needsUpdate = true;
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
    this.steam.update(frameDt, temp, this.quality.scale);

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
    this.hud.update({
      gauges: this.gauges,
      payout: this.payout,
      fever: this.fever.isFever,
      feverMultiplier: this.fever.multiplier,
      coldBathReady: feverIdle && this.gauges.isTotonoiReady && !this.machine.inputBlocked,
      pendingMultiplier: pending.multiplier,
      pendingDuration: pending.duration,
      canThrow: this.payout.canThrow(this.fever.isFever) && !this.machine.inputBlocked,
      throwReady: this.spawner.isReady(this.loop.now, this.fever.isFever),
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
    this.gauges.reset();
    this.payout.reset();
    this.pusher.reset();
    this.spawner.reset();
    this.items.reset();
    this.fever.reset();
    this.hud.reset();
    this.hud.setAiming(false);
    this.audio.setFeverMusic(false);
    this.setOutdoorMood(false);
    this.cameraRig.setShot('play');
    this.gameOverDelay = 0;
    this.pendingLoyly = 0;
    this.waterAmount = 0;
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
      /** 投入レーンの normalizedX を指定して投げる */
      throwAt: (normalizedX: number) => this.tryThrow(normalizedX),
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
      }),
      addStones: (n: number) => {
        this.payout.stoneCount += n;
      },
      setTemperature: (t: number) => {
        this.gauges.temperature = t;
      },
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
