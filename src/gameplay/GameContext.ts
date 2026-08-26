import type { EventBus } from '../core/EventBus';
import type { Gauges } from './Gauges';

/**
 * アイテム効果がゲームに触るための最小の窓口（仕様 8.4）。
 * ItemDef.onPayout はこれ以外の経路でゲームを触らないこと。
 * 未承認アイテム（仕様 8.3 ヴィヒタ／サウナハット／砂時計）を後から足しても
 * このインターフェースだけで書けるよう、効果の種類ごとにメソッドを分けてある。
 */
export interface GameContext {
  readonly bus: EventBus;
  readonly gauges: Gauges;
  /** 体力を回復する */
  healStamina(amount: number): void;
  /** 一時的なスローモーション演出 */
  slowMotion(scale: number, durationSec: number): void;
}
