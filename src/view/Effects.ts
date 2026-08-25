import * as THREE from 'three';
import { BALANCE } from '../core/BalanceConfig';

/**
 * 演出（仕様 10章）。優先度順に実装してあり、性能が足りなければ
 * QualityScaler が下位のものから削る。
 *   1. 蒸気パーティクル（温度に比例して密度up）
 *   2. 高温時の陽炎（軽量な UV 歪み）＋画面周縁の赤み（周縁は HUD 側の CSS）
 *   3. ストーンの自発光
 *   4. 水風呂トランジション（青のフラッシュ＋水面歪み）
 *   5. ストーブの炎、光源のちらつき
 */

const MAX_STEAM = 220;

export class SteamSystem {
  readonly points: THREE.Points;
  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly lives: Float32Array;
  private readonly maxLives: Float32Array;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.PointsMaterial;

  constructor() {
    this.positions = new Float32Array(MAX_STEAM * 3);
    this.velocities = new Float32Array(MAX_STEAM * 3);
    this.lives = new Float32Array(MAX_STEAM);
    this.maxLives = new Float32Array(MAX_STEAM);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setDrawRange(0, 0);

    // 盤面は 0.6m 四方しかない。粒を大きくすると画面が白い塊で埋まるので小さく薄く。
    this.material = new THREE.PointsMaterial({
      size: 0.02,
      map: makeSteamSprite(),
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      blending: THREE.NormalBlending,
      color: 0xf2e6d8,
      sizeAttenuation: true,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;

    for (let i = 0; i < MAX_STEAM; i += 1) this.respawn(i);
  }

  /**
   * @param temperature 現在の室温
   * @param qualityScale 品質段階に応じた密度倍率
   */
  update(dt: number, temperature: number, qualityScale: number): void {
    const cfg = BALANCE.view.steam;
    const heat = THREE.MathUtils.clamp(
      (temperature - cfg.minTemp) / (BALANCE.temperature.max - cfg.minTemp),
      0,
      1,
    );
    const target = Math.floor(Math.min(cfg.maxParticles, MAX_STEAM) * heat * qualityScale);
    this.material.opacity = 0.08 + heat * 0.16;

    for (let i = 0; i < target; i += 1) {
      this.lives[i] = (this.lives[i] as number) + dt;
      if ((this.lives[i] as number) >= (this.maxLives[i] as number)) {
        this.respawn(i);
        continue;
      }
      const o = i * 3;
      // 熱いほど速く立ち上る
      const rise = 1 + heat * 0.8;
      this.positions[o] = (this.positions[o] as number) + (this.velocities[o] as number) * dt;
      this.positions[o + 1] =
        (this.positions[o + 1] as number) + (this.velocities[o + 1] as number) * rise * dt;
      this.positions[o + 2] = (this.positions[o + 2] as number) + (this.velocities[o + 2] as number) * dt;
    }

    this.geometry.setDrawRange(0, target);
    this.geometry.attributes.position!.needsUpdate = true;
  }

  private respawn(i: number): void {
    const f = BALANCE.field;
    const o = i * 3;
    // ストーブ（手前・ペイアウトの落下先）から立ち上る
    this.positions[o] = (Math.random() - 0.5) * f.halfWidth * 2;
    this.positions[o + 1] = f.lowerTableY - 0.04 + Math.random() * 0.05;
    this.positions[o + 2] = f.payoutZ - 0.1 + Math.random() * 0.12;
    // 盤面の高さは 0.2m ほど。寿命×上昇速度がこれを大きく超えると
    // 蒸気が画面上方の何もない空間まで登って邪魔になる。
    this.velocities[o] = (Math.random() - 0.5) * 0.04;
    this.velocities[o + 1] = 0.06 + Math.random() * 0.07;
    this.velocities[o + 2] = (Math.random() - 0.5) * 0.03 + 0.015;
    this.lives[i] = 0;
    this.maxLives[i] = 1.2 + Math.random() * 1.0;
  }

  /** ロウリュ着弾時に一気に噴き出させる */
  burst(x: number, z: number): void {
    const count = Math.min(60, MAX_STEAM);
    for (let i = 0; i < count; i += 1) {
      const o = i * 3;
      this.positions[o] = x + (Math.random() - 0.5) * 0.1;
      this.positions[o + 1] = BALANCE.field.lowerTableY + Math.random() * 0.03;
      this.positions[o + 2] = z + (Math.random() - 0.5) * 0.1;
      this.velocities[o] = (Math.random() - 0.5) * 0.25;
      this.velocities[o + 1] = 0.2 + Math.random() * 0.25;
      this.velocities[o + 2] = (Math.random() - 0.5) * 0.25;
      this.lives[i] = 0;
      this.maxLives[i] = 0.8 + Math.random() * 0.7;
    }
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.material.map?.dispose();
  }
}

/**
 * 陽炎／水面歪みのフルスクリーンパス（仕様 10章 2 と 4）。
 * 本格的な屈折はモバイルに重いので、UV を sin で押す最小構成にしてある。
 * 歪み量が 0 のときは呼び出し側がパスごと省略する。
 */
export class DistortionPass {
  readonly target: THREE.WebGLRenderTarget;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly material: THREE.ShaderMaterial;

  constructor(width: number, height: number) {
    this.target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: this.target.texture },
        uTime: { value: 0 },
        /** 陽炎の強さ 0..1 */
        uHeat: { value: 0 },
        /** 水面歪みの強さ 0..1 */
        uWater: { value: 0 },
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        precision mediump float;
        uniform sampler2D tDiffuse;
        uniform float uTime;
        uniform float uHeat;
        uniform float uWater;
        varying vec2 vUv;

        void main() {
          vec2 uv = vUv;

          // 陽炎: 下ほど、そして画面端ほど強く揺らす
          float heatMask = uHeat * (1.0 - uv.y) * 1.4;
          uv.x += sin(uv.y * 42.0 + uTime * 3.2) * 0.0035 * heatMask;
          uv.y += cos(uv.x * 31.0 + uTime * 2.1) * 0.0022 * heatMask;

          // 水面: 全面に横波
          uv.x += sin(uv.y * 14.0 - uTime * 5.0) * 0.02 * uWater;
          uv.y += sin(uv.x * 11.0 + uTime * 4.0) * 0.015 * uWater;

          vec4 color = texture2D(tDiffuse, clamp(uv, 0.001, 0.999));

          // 水風呂中は青へ寄せる
          color.rgb = mix(color.rgb, color.rgb * vec3(0.55, 0.8, 1.35) + vec3(0.0, 0.05, 0.12), uWater);
          gl_FragColor = color;
        }
      `,
      depthTest: false,
      depthWrite: false,
    });

    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  setSize(width: number, height: number): void {
    this.target.setSize(width, height);
  }

  set(time: number, heat: number, water: number): void {
    this.material.uniforms.uTime!.value = time;
    this.material.uniforms.uHeat!.value = heat;
    this.material.uniforms.uWater!.value = water;
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.setRenderTarget(null);
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}

/** 蒸気用のふわっとした円形スプライトを生成する（外部画像を使わない） */
function makeSteamSprite(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  return new THREE.CanvasTexture(canvas);
}
