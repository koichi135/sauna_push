import { BALANCE } from './BalanceConfig';

export interface LoopCallbacks {
  /** 固定ステップで呼ばれる。物理とゲームロジックはここだけで進める */
  fixedUpdate: (dt: number) => void;
  /** 毎フレーム1回。描画とUIの補間はここ */
  render: (frameDt: number, alpha: number) => void;
}

/**
 * 固定タイムステップのゲームループ（仕様 2章「禁止事項」/ 3章）。
 *
 * - 物理はレンダーフレーム時間で直接進めない。必ず accumulator + fixedTimeStep。
 * - 1フレームあたりのサブステップは maxSubStepsPerFrame で打ち切る。
 *   打ち切った分の accumulator は捨てる（スパイラル・オブ・デス防止）。
 * - PAUSED からの復帰やタブ復帰で溜まった時間は反映しない（仕様 11章）。
 */
export class GameLoop {
  private rafId = 0;
  private running = false;
  private lastTime = 0;
  private accumulator = 0;
  /** オロポのスローモーション用。1.0 で等速 */
  private timeScale = 1;
  private timeScaleUntil = 0;
  /** ループ内の経過時間（timeScale 適用後、PAUSED 中は進まない） */
  private elapsed = 0;

  private fpsSamples: number[] = [];
  private fpsValue = 60;

  constructor(private readonly callbacks: LoopCallbacks) {}

  get now(): number {
    return this.elapsed;
  }

  get fps(): number {
    return this.fpsValue;
  }

  /** 一時的に時間を遅くする（オロポ演出）。 */
  setSlowMotion(scale: number, durationSec: number): void {
    this.timeScale = scale;
    this.timeScaleUntil = this.elapsed + durationSec;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  /**
   * 描画を挟まずに固定ステップを1回進める。デバッグ用のテストハーネス専用。
   * 実フレームレートに縛られずゲーム内時間で挙動を測るために使う。
   */
  tickManually(): void {
    const step = BALANCE.physics.fixedTimeStep;
    this.elapsed += step;
    this.callbacks.fixedUpdate(step);
  }

  /**
   * タブ復帰・ポーズ解除で呼ぶ。溜まった実時間を破棄して、
   * 放置分がゲージに反映されるのを防ぐ（仕様 11章）。
   */
  resetTimeBase(): void {
    this.lastTime = performance.now();
    this.accumulator = 0;
  }

  private readonly tick = (time: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    // 実フレーム時間。長すぎるフレームは 0.25s で頭打ちにして accumulator の暴走を防ぐ。
    const rawDt = Math.min((time - this.lastTime) / 1000, 0.25);
    this.lastTime = time;

    this.sampleFps(rawDt);

    if (this.elapsed >= this.timeScaleUntil && this.timeScale !== 1) {
      this.timeScale = 1;
    }

    const step = BALANCE.physics.fixedTimeStep;
    this.accumulator += rawDt * this.timeScale;

    let steps = 0;
    const maxSteps = BALANCE.physics.maxSubStepsPerFrame;
    while (this.accumulator >= step && steps < maxSteps) {
      this.elapsed += step;
      this.callbacks.fixedUpdate(step);
      this.accumulator -= step;
      steps += 1;
    }
    // 上限で打ち切った場合、残りは捨てる。追いつこうとすると更に重くなるため。
    if (steps >= maxSteps && this.accumulator > step) {
      this.accumulator = 0;
    }

    this.callbacks.render(rawDt, this.accumulator / step);
  };

  private sampleFps(rawDt: number): void {
    if (rawDt <= 0) return;
    this.fpsSamples.push(1 / rawDt);
    if (this.fpsSamples.length > 30) this.fpsSamples.shift();
    let sum = 0;
    for (const s of this.fpsSamples) sum += s;
    this.fpsValue = sum / this.fpsSamples.length;
  }
}
