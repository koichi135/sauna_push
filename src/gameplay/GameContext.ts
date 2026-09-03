import type { EventBus } from '../core/EventBus';
import type { Gauges } from './Gauges';

/**
 * アイテム効果がゲームに触るための最小の窓口（仕様 8.4）。
 * ItemDef.onPayout はこれ以外の経路でゲームを触らないこと。
 * 効果の種類ごとにメソッドを分けてあるので、アイテムを足すときはここに 1 つ増やす。
 */
export interface GameContext {
  readonly bus: EventBus;
  readonly gauges: Gauges;
  /** 体力を回復する（オロポ） */
  healStamina(amount: number): void;
  /** 一時的なスローモーション演出 */
  slowMotion(scale: number, durationSec: number): void;
  /** 盤面上の全ストーンを手前へ扇ぐ（ヴィヒタ） */
  pushAllStones(velocityZ: number, liftY: number): void;
  /** 一定時間、温度帯ダメージを無効化する（サウナハット） */
  addHeatShield(seconds: number): void;
  /** フィーバー中なら延長、それ以外はととのい加算（砂時計） */
  extendFeverOrTotonoi(feverSeconds: number, totonoiGain: number): void;
}
