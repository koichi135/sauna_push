import { BALANCE } from '../core/BalanceConfig';

/**
 * 音（仕様 10章）。
 * 外部アセットの動的ロードは禁止されているため、全て WebAudio による手続き生成にしてある。
 * iOS は初回のユーザー操作でしか AudioContext を開始できないので unlock() を必ず通すこと。
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private unlocked = false;
  private muted = false;

  /** 同時発音数制限（仕様 10章）。再生中の衝突音の終了時刻を保持する */
  private impactVoices: number[] = [];
  private noiseBuffer: AudioBuffer | null = null;

  private heartbeatTimer = 0;
  private heartbeatActive = false;
  private ambientNodes: { osc: OscillatorNode; gain: GainNode }[] = [];

  /** 初回タップから呼ぶ。iOS のオーディオアンロック。 */
  async unlock(): Promise<void> {
    if (this.unlocked) return;
    type WindowWithWebkit = Window & { webkitAudioContext?: typeof AudioContext };
    const Ctor = window.AudioContext ?? (window as WindowWithWebkit).webkitAudioContext;
    if (!Ctor) return;

    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = BALANCE.audio.masterVolume;
    this.master.connect(this.ctx.destination);

    this.musicGain = this.ctx.createGain();
    this.musicGain.gain.value = 0;
    this.musicGain.connect(this.master);

    this.noiseBuffer = this.makeNoiseBuffer();

    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.unlocked = true;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : BALANCE.audio.masterVolume, this.ctx.currentTime, 0.05);
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  suspend(): void {
    void this.ctx?.suspend();
  }

  resume(): void {
    void this.ctx?.resume();
  }

  /**
   * ストーンの衝突音。ピッチをランダム化し、同時発音数を制限する（仕様 10章）。
   * @param intensity 0..1 相当の強さ
   */
  playImpact(intensity: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;

    const now = ctx.currentTime;
    this.impactVoices = this.impactVoices.filter((end) => end > now);
    if (this.impactVoices.length >= BALANCE.audio.maxImpactVoices) return;

    const jitter = BALANCE.audio.impactPitchJitter;
    const pitch = 1 + (Math.random() * 2 - 1) * jitter;
    const dur = 0.075;

    // 石同士のカツンという音: 短いノイズバースト + バンドパス
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.playbackRate.value = pitch;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1400 * pitch;
    filter.Q.value = 3.5;

    const gain = ctx.createGain();
    const level = Math.min(0.32, 0.08 + intensity * 0.3);
    gain.gain.setValueAtTime(level, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(filter).connect(gain).connect(this.master);
    src.start(now);
    src.stop(now + dur);
    this.impactVoices.push(now + dur);
  }

  /** ロウリュの「ジュワッ」。ハイパスしたノイズを減衰させる。 */
  playLoyly(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const now = ctx.currentTime;
    const dur = 1.2;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.setValueAtTime(900, now);
    filter.frequency.exponentialRampToValueAtTime(5200, now + dur);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.34, now + 0.06);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);

    src.connect(filter).connect(gain).connect(this.master);
    src.start(now);
    src.stop(now + dur);
  }

  /** 水風呂の水音。低めのノイズと下降するトーン。 */
  playColdBath(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const now = ctx.currentTime;
    const dur = 1.4;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2600, now);
    filter.frequency.exponentialRampToValueAtTime(320, now + dur);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.4, now + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(now);
    src.stop(now + dur);

    this.playTone(520, 180, 0.9, 'sine', 0.16);
  }

  /** ペイアウトの獲得音 */
  playPayout(pitchScale = 1): void {
    this.playTone(880 * pitchScale, 1320 * pitchScale, 0.14, 'triangle', 0.12);
  }

  /** オロポの炭酸シズル */
  playOropo(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const now = ctx.currentTime;
    const dur = 0.7;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'highpass';
    filter.frequency.value = 4200;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.18, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(now);
    src.stop(now + dur);
    this.playTone(660, 990, 0.35, 'sine', 0.1);
  }

  playGameOver(): void {
    this.playTone(420, 110, 1.6, 'sawtooth', 0.16);
  }

  /** タイムアタックを生き延びてクリアしたときの上昇ファンファーレ */
  playRunClear(): void {
    this.playTone(440, 660, 0.22, 'triangle', 0.16);
    window.setTimeout(() => this.playTone(660, 880, 0.28, 'triangle', 0.16), 160);
    window.setTimeout(() => this.playTone(880, 1320, 0.5, 'triangle', 0.18), 340);
  }

  /** 大玉ストーンの獲得（上昇するファンファーレ）とペイアウト（重い着地音） */
  playBigStoneEarned(): void {
    this.playTone(523, 784, 0.18, 'triangle', 0.14);
    window.setTimeout(() => this.playTone(784, 1046, 0.28, 'triangle', 0.14), 120);
  }

  playBigStonePaid(): void {
    this.playTone(160, 55, 0.35, 'sine', 0.4);
    this.playTone(1100, 1500, 0.2, 'triangle', 0.12);
  }

  /** コンボの節目（5 連鎖ごと）。段が上がるほど高く鳴る */
  playComboMilestone(step: number): void {
    const base = 660 * Math.pow(1.06, Math.min(step, 12));
    this.playTone(base, base * 1.5, 0.22, 'square', 0.08);
  }

  /** ヴィヒタの「バサッ」。低めのノイズを短く */
  playVihta(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const now = ctx.currentTime;
    const dur = 0.45;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(600, now);
    filter.frequency.exponentialRampToValueAtTime(3000, now + 0.08);
    filter.frequency.exponentialRampToValueAtTime(300, now + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.42, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(now);
    src.stop(now + dur);
  }

  /** サウナハット（柔らかい二音） */
  playHat(): void {
    this.playTone(440, 440, 0.18, 'sine', 0.14);
    window.setTimeout(() => this.playTone(587, 587, 0.3, 'sine', 0.14), 140);
  }

  /** 砂時計（チクタク） */
  playHourglass(): void {
    this.playTone(1800, 1200, 0.05, 'square', 0.06);
    window.setTimeout(() => this.playTone(1500, 1000, 0.05, 'square', 0.06), 110);
    window.setTimeout(() => this.playTone(700, 1050, 0.3, 'triangle', 0.12), 240);
  }

  /** フィーバー（外気浴）中のアンビエント。開始／停止で呼ぶ。 */
  setFeverMusic(on: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicGain) return;
    const now = ctx.currentTime;

    if (on && this.ambientNodes.length === 0) {
      // 開放感のある和音を薄く重ねる
      for (const freq of [220, 277.18, 329.63, 440]) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const gain = ctx.createGain();
        gain.gain.value = 0.16;
        // わずかにデチューンして揺らぎを出す
        osc.detune.value = (Math.random() - 0.5) * 12;
        osc.connect(gain).connect(this.musicGain);
        osc.start(now);
        this.ambientNodes.push({ osc, gain });
      }
      this.musicGain.gain.setTargetAtTime(0.22, now, 0.4);
    } else if (!on && this.ambientNodes.length > 0) {
      this.musicGain.gain.setTargetAtTime(0, now, 0.3);
      const nodes = this.ambientNodes;
      this.ambientNodes = [];
      for (const { osc } of nodes) osc.stop(now + 1.2);
    }
  }

  /** 低体力時の心拍。update から毎フレーム呼ぶ。 */
  updateHeartbeat(dt: number, active: boolean, urgency: number): void {
    this.heartbeatActive = active;
    if (!active) {
      this.heartbeatTimer = 0;
      return;
    }
    // 体力が減るほど速くなる
    const interval = 0.95 - urgency * 0.4;
    this.heartbeatTimer += dt;
    if (this.heartbeatTimer >= interval) {
      this.heartbeatTimer = 0;
      this.playTone(72, 46, 0.16, 'sine', 0.34);
      // ドクン、の2拍目
      window.setTimeout(() => {
        if (this.heartbeatActive) this.playTone(64, 40, 0.13, 'sine', 0.22);
      }, 165);
    }
  }

  private playTone(
    fromHz: number,
    toHz: number,
    dur: number,
    type: OscillatorType,
    level: number,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.master || this.muted) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(fromHz, now);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, toHz), now + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(level, now + Math.min(0.02, dur * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    osc.connect(gain).connect(this.master);
    osc.start(now);
    osc.stop(now + dur + 0.02);
  }

  private makeNoiseBuffer(): AudioBuffer | null {
    const ctx = this.ctx;
    if (!ctx) return null;
    const length = Math.floor(ctx.sampleRate * 0.5);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  }
}
