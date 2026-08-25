import './ui/styles.css';
import { initPhysics } from './physics/PhysicsWorld';
import { Game } from './gameplay/Game';
import { el } from './ui/dom';

/**
 * エントリポイント。
 * Rapier は WASM の初期化が非同期なので、World を作る前に必ず待つ。
 */
async function boot(): Promise<void> {
  const canvas = el<HTMLCanvasElement>('game-canvas');

  try {
    await initPhysics();
    new Game(canvas);
  } catch (error) {
    console.error('起動に失敗しました', error);
    const loading = document.getElementById('screen-loading');
    if (loading) {
      loading.innerHTML =
        '<p class="loading-text">起動に失敗しました。<br />ページを再読み込みしてください。</p>';
    }
    return;
  }
}

void boot();
