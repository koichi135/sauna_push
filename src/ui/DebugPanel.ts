import { BALANCE } from '../core/BalanceConfig';

/**
 * `?debug=1` で表示される実機用の調整パネル（仕様 12章、必須要件）。
 * dat.GUI 相当の機能を依存追加なしで用意する。
 * BALANCE を直接書き換えるため、ロジック側は毎回 BALANCE から値を読むこと。
 */

interface SliderSpec {
  path: string;
  label: string;
  min: number;
  max: number;
  step: number;
}

interface Group {
  title: string;
  sliders: SliderSpec[];
}

const GROUPS: Group[] = [
  {
    title: '物理',
    sliders: [
      { path: 'physics.gravity', label: '重力', min: -40, max: -4, step: 0.5 },
      { path: 'physics.stone.friction', label: '摩擦', min: 0, max: 1.2, step: 0.01 },
      { path: 'physics.stone.restitution', label: '反発', min: 0, max: 0.6, step: 0.01 },
      { path: 'physics.stone.linearDamping', label: '線減衰', min: 0, max: 1.5, step: 0.01 },
      { path: 'physics.maxActiveBodies', label: '剛体上限', min: 20, max: 240, step: 5 },
    ],
  },
  {
    title: 'プッシャー',
    sliders: [
      { path: 'pusher.stroke', label: 'ストローク', min: 0.02, max: 0.25, step: 0.005 },
      { path: 'pusher.period', label: '周期', min: 0.6, max: 6, step: 0.1 },
      { path: 'pusher.feverPeriod', label: '周期(F)', min: 0.3, max: 4, step: 0.1 },
    ],
  },
  {
    title: '温度',
    sliders: [
      { path: 'temperature.coolPerSec', label: '自然放熱/s', min: -8, max: 0, step: 0.1 },
      { path: 'temperature.gainPerPayout', label: '落下+', min: 0, max: 8, step: 0.1 },
    ],
  },
  {
    title: 'ととのい',
    sliders: [
      { path: 'totonoi.basePerSec', label: '基礎/s', min: 0, max: 30, step: 0.5 },
      { path: 'totonoi.payoutBonusPerSec', label: '落下ボーナス', min: 0, max: 8, step: 0.1 },
      { path: 'totonoi.autoColdBathSec', label: '自動入水まで', min: 2, max: 30, step: 0.5 },
    ],
  },
  {
    title: '体力',
    sliders: [
      { path: 'stamina.starvingPerSec', label: '枯渇/s', min: -12, max: 0, step: 0.25 },
      { path: 'stamina.warningRatio', label: '警告閾値', min: 0.05, max: 0.6, step: 0.01 },
    ],
  },
  {
    title: 'フィーバー',
    sliders: [
      { path: 'fever.coldBathSec', label: '入水演出', min: 0.4, max: 4, step: 0.1 },
      { path: 'fever.multiplierMax', label: '最大倍率', min: 1.2, max: 6, step: 0.1 },
      { path: 'fever.baseDurationSec', label: '基礎秒数', min: 3, max: 25, step: 0.5 },
      { path: 'fever.durationMax', label: '最大秒数', min: 5, max: 40, step: 0.5 },
    ],
  },
  {
    title: 'ストーン収支',
    sliders: [
      { path: 'stones.initial', label: '初期数', min: 5, max: 120, step: 1 },
      { path: 'stones.gainPerPayout', label: '獲得数', min: 1, max: 6, step: 1 },
      { path: 'spawn.cooldownMs', label: '連射CD', min: 40, max: 900, step: 10 },
    ],
  },
  {
    title: 'アイテム',
    sliders: [
      { path: 'items.intervalSec', label: '出現間隔', min: 5, max: 120, step: 1 },
      { path: 'items.maxOnBoard', label: '同時数', min: 1, max: 8, step: 1 },
      { path: 'items.oropo.staminaGain', label: 'オロポ回復', min: 5, max: 100, step: 1 },
    ],
  },
  {
    title: 'コンボ / セット',
    sliders: [
      { path: 'combo.windowSec', label: '連鎖窓(s)', min: 0.2, max: 3, step: 0.1 },
      { path: 'combo.scorePerStep', label: '倍率/段', min: 0, max: 0.5, step: 0.01 },
      { path: 'combo.bigStoneEvery', label: '大玉まで', min: 3, max: 30, step: 1 },
      { path: 'sets.coolingPerSet', label: '放熱↑/set', min: 0, max: 0.3, step: 0.01 },
      { path: 'sets.damagePerSet', label: 'ダメ↑/set', min: 0, max: 0.5, step: 0.01 },
      { path: 'fever.autoDurationSec', label: '自動F秒数', min: 0, max: 14, step: 0.5 },
    ],
  },
  {
    title: 'ロウリュ',
    sliders: [
      { path: 'loyly.cooldownSec', label: 'クールタイム', min: 2, max: 40, step: 0.5 },
      { path: 'loyly.radius', label: '影響半径', min: 0.04, max: 0.3, step: 0.01 },
      { path: 'loyly.pushVelocity', label: '押し出し速度', min: 0.1, max: 1.2, step: 0.02 },
      { path: 'loyly.wetDurationSec', label: '濡れ時間', min: 1, max: 20, step: 0.5 },
      { path: 'loyly.tempPerStonePerSec', label: '温度/個/s', min: 0.05, max: 3, step: 0.05 },
      { path: 'loyly.maxStones', label: '個数上限', min: 1, max: 30, step: 1 },
      { path: 'loyly.wetDarkness', label: '濡れの黒さ', min: 0, max: 0.95, step: 0.01 },
    ],
  },
  {
    title: 'ラン',
    sliders: [{ path: 'run.durationSec', label: '制限時間(s)', min: 30, max: 360, step: 10 }],
  },
];

export interface DebugActions {
  addStones: (n: number) => void;
  addBigStone: () => void;
  setTemperature: (t: number) => void;
  forceColdBath: () => void;
  spawnItem: () => void;
  killPlayer: () => void;
  setQuality: (step: number) => void;
}

export interface DebugStats {
  fps: number;
  bodies: number;
  quality: number;
  state: string;
}

export class DebugPanel {
  private readonly root: HTMLElement;
  private readonly statsNode: HTMLElement;
  private readonly headFps: HTMLElement;
  private lastRender = 0;

  constructor(actions: DebugActions) {
    this.root = document.createElement('div');
    // 320px 幅の実機ではパネルが盤面とボタンを覆ってしまうので、既定は畳んでおく。
    // 見出しの fps だけ常に見えるようにして、開かなくても性能は追える。
    this.root.className = 'debug-panel collapsed';

    const head = document.createElement('div');
    head.className = 'debug-head';
    const headLabel = document.createElement('span');
    headLabel.textContent = 'DEBUG';
    this.headFps = document.createElement('span');
    this.headFps.textContent = '--';
    head.append(headLabel, this.headFps);
    head.addEventListener('click', () => this.root.classList.toggle('collapsed'));
    this.root.appendChild(head);

    const body = document.createElement('div');
    body.className = 'debug-body';
    this.root.appendChild(body);

    this.statsNode = document.createElement('div');
    this.statsNode.className = 'debug-stats';
    body.appendChild(this.statsNode);

    const actionRow = document.createElement('div');
    actionRow.className = 'debug-actions';
    const buttons: [string, () => void][] = [
      ['🪨+30', () => actions.addStones(30)],
      ['大玉+1', () => actions.addBigStone()],
      ['温度90', () => actions.setTemperature(90)],
      ['温度55', () => actions.setTemperature(55)],
      ['水風呂', () => actions.forceColdBath()],
      ['アイテム', () => actions.spawnItem()],
      ['GameOver', () => actions.killPlayer()],
      ['品質-', () => actions.setQuality(1)],
      ['品質+', () => actions.setQuality(0)],
    ];
    for (const [label, fn] of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.addEventListener('click', fn);
      actionRow.appendChild(btn);
    }
    body.appendChild(actionRow);

    for (const group of GROUPS) {
      const title = document.createElement('div');
      title.className = 'debug-group';
      title.textContent = group.title;
      body.appendChild(title);
      for (const spec of group.sliders) body.appendChild(this.buildSlider(spec));
    }

    document.getElementById('app')?.appendChild(this.root);
  }

  private buildSlider(spec: SliderSpec): HTMLElement {
    const row = document.createElement('div');
    row.className = 'debug-row';

    const label = document.createElement('label');
    label.textContent = spec.label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    const initial = readPath(spec.path);
    input.value = String(initial);

    const output = document.createElement('output');
    output.textContent = format(initial);

    input.addEventListener('input', () => {
      const value = Number.parseFloat(input.value);
      writePath(spec.path, value);
      output.textContent = format(value);
    });

    const id = `dbg-${spec.path.replace(/\./g, '-')}`;
    input.id = id;
    label.htmlFor = id;

    row.append(label, input, output);
    return row;
  }

  update(stats: DebugStats, nowMs: number): void {
    // 毎フレーム DOM を触ると計測対象の fps 自体に効いてしまうので間引く
    if (nowMs - this.lastRender < 250) return;
    this.lastRender = nowMs;
    const color = stats.fps < 30 ? '#ff8f7a' : '#9fe8a0';
    this.headFps.textContent = `${stats.fps.toFixed(0)}fps`;
    this.headFps.style.color = color;
    this.statsNode.textContent =
      `fps ${stats.fps.toFixed(0)}  剛体 ${stats.bodies}\n` +
      `品質 ${stats.quality}  状態 ${stats.state}`;
    this.statsNode.style.whiteSpace = 'pre';
    this.statsNode.style.color = color;
  }
}

type Mutable = Record<string, unknown>;

function readPath(path: string): number {
  let node: unknown = BALANCE;
  for (const key of path.split('.')) {
    node = (node as Mutable)[key];
  }
  return typeof node === 'number' ? node : 0;
}

function writePath(path: string, value: number): void {
  const keys = path.split('.');
  const last = keys.pop();
  if (last === undefined) return;
  let node: unknown = BALANCE;
  for (const key of keys) node = (node as Mutable)[key];
  (node as Mutable)[last] = value;
}

function format(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(Math.abs(value) < 1 ? 3 : 2);
}

export function isDebugEnabled(): boolean {
  return new URLSearchParams(window.location.search).get('debug') === '1';
}
