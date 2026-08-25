import * as THREE from 'three';
import { BALANCE } from '../core/BalanceConfig';

/**
 * 固定俯瞰カメラ（仕様 9章）。プレイヤーはカメラを操作できない。
 * フィーバー突入・ゲームオーバー時のみスクリプト演出で動かす。
 */
export type CameraShot = 'play' | 'coldBath' | 'fever' | 'gameOver';

interface Shot {
  /** 注視点 */
  target: THREE.Vector3;
  pitchDeg: number;
  distance: number;
  /** 水平方向の回り込み（度） */
  yawDeg: number;
  fov: number;
}

/**
 * 盤面は幅 0.60・奥行 0.50。縦持ちの横画角は狭いので、
 * play ショットは幅がぎりぎり収まる距離に取ってある。寄せすぎるとロスト溝が画面外に出る。
 */
const SHOTS: Record<CameraShot, Shot> = {
  play: { target: new THREE.Vector3(0, -0.02, -0.04), pitchDeg: 45, distance: 1.5, yawDeg: 0, fov: 46 },
  // 入水: 少し寄って沈み込む
  coldBath: { target: new THREE.Vector3(0, -0.05, -0.08), pitchDeg: 30, distance: 1.2, yawDeg: -8, fov: 48 },
  // 外気浴: 引いて空が抜ける画に
  fever: { target: new THREE.Vector3(0, 0.04, -0.02), pitchDeg: 40, distance: 1.68, yawDeg: 6, fov: 52 },
  gameOver: { target: new THREE.Vector3(0, -0.04, -0.06), pitchDeg: 20, distance: 1.05, yawDeg: 14, fov: 42 },
};

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  private shot: CameraShot = 'play';
  private readonly current: Shot;
  private shakeAmount = 0;
  private readonly tmpTarget = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(BALANCE.view.cameraFov, aspect, 0.02, 12);
    const play = SHOTS.play;
    this.current = {
      target: play.target.clone(),
      pitchDeg: BALANCE.view.cameraPitchDeg,
      distance: BALANCE.view.cameraDistance,
      yawDeg: play.yawDeg,
      fov: play.fov,
    };
    this.apply(0);
  }

  setShot(shot: CameraShot): void {
    this.shot = shot;
  }

  /** ロウリュ着弾やゲームオーバーで画面を揺らす */
  shake(amount: number): void {
    this.shakeAmount = Math.max(this.shakeAmount, amount);
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  /** 毎フレーム。目標ショットへ指数補間で寄せる。 */
  update(frameDt: number): void {
    const goal = SHOTS[this.shot];
    // frameDt に依存しない減衰率にして、fps が変わっても寄り方が変わらないようにする
    const k = 1 - Math.exp(-frameDt * 4.5);
    this.current.target.lerp(goal.target, k);
    this.current.pitchDeg += (goal.pitchDeg - this.current.pitchDeg) * k;
    this.current.distance += (goal.distance - this.current.distance) * k;
    this.current.yawDeg += (goal.yawDeg - this.current.yawDeg) * k;
    this.current.fov += (goal.fov - this.current.fov) * k;

    this.shakeAmount *= Math.exp(-frameDt * 6);
    if (this.shakeAmount < 0.0005) this.shakeAmount = 0;

    this.apply(this.shakeAmount);
  }

  private apply(shake: number): void {
    const pitch = THREE.MathUtils.degToRad(this.current.pitchDeg);
    const yaw = THREE.MathUtils.degToRad(this.current.yawDeg);
    const d = this.current.distance;

    // プレイヤーは -Z 側から +Z 方向を見る（仕様 3章）
    const x = Math.sin(yaw) * Math.cos(pitch) * d;
    const y = Math.sin(pitch) * d;
    const z = -Math.cos(yaw) * Math.cos(pitch) * d;

    this.tmpTarget.copy(this.current.target);
    this.camera.position.set(
      this.tmpTarget.x + x + (Math.random() - 0.5) * shake,
      this.tmpTarget.y + y + (Math.random() - 0.5) * shake,
      this.tmpTarget.z + z + (Math.random() - 0.5) * shake,
    );
    this.camera.lookAt(this.tmpTarget);
    if (Math.abs(this.camera.fov - this.current.fov) > 0.01) {
      this.camera.fov = this.current.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
