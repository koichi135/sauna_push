import * as THREE from 'three';
import { BALANCE } from '../core/BalanceConfig';

/**
 * サウナ室の見た目。外部アセットは使わず、すべてプリミティブと手続き的テクスチャで作る
 * （仕様 2章「外部アセットのCDN動的ロード禁止」）。
 * アートテイストは仕様 15章4項が未決のため、木目のデフォルメ路線を暫定採用。
 */

export interface SceneRefs {
  scene: THREE.Scene;
  stoneMesh: THREE.InstancedMesh;
  itemGroup: THREE.Group;
  /** 板と後端リップをまとめた Group。Z のみ物理から同期する */
  pusherMesh: THREE.Object3D;
  stoveGlow: THREE.PointLight;
  stoveFire: THREE.Mesh;
  roomLight: THREE.PointLight;
  ambient: THREE.AmbientLight;
  wallMaterial: THREE.MeshStandardMaterial;
  stoneMaterial: THREE.MeshStandardMaterial;
}

const MAX_STONE_INSTANCES = 256;

export function buildScene(): SceneRefs {
  const f = BALANCE.field;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a0f0a);
  scene.fog = new THREE.Fog(0x2a180f, 0.9, 2.4);

  const woodTexture = makeWoodTexture();

  // ---- サウナ室 -------------------------------------------------------
  const wallMaterial = new THREE.MeshStandardMaterial({
    map: woodTexture,
    color: 0xb98a5a,
    roughness: 0.85,
    metalness: 0.02,
    side: THREE.BackSide,
  });
  const room = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.0, 1.6), wallMaterial);
  room.position.set(0, 0.28, 0.1);
  scene.add(room);

  // ---- 盤面 -----------------------------------------------------------
  const benchMaterial = new THREE.MeshStandardMaterial({
    map: woodTexture,
    color: 0xc99a68,
    roughness: 0.7,
    metalness: 0.03,
  });

  // 下段テーブル
  const tableDepth = f.backZ - f.payoutZ;
  const table = new THREE.Mesh(
    new THREE.BoxGeometry(f.halfWidth * 2, 0.02, tableDepth),
    benchMaterial,
  );
  table.position.set(0, f.lowerTableY - 0.01, (f.backZ + f.payoutZ) / 2);
  table.receiveShadow = true;
  scene.add(table);

  // 投入シュート（フード兼用）。物理側 buildChute と同じ姿勢で置く
  const c = f.chute;
  const chuteLength = Math.hypot(c.backZ - c.frontZ, c.backY - c.frontY);
  const chuteMaterial = new THREE.MeshStandardMaterial({
    color: 0x7d7a86,
    roughness: 0.45,
    metalness: 0.5,
  });
  const chute = new THREE.Mesh(
    new THREE.BoxGeometry(f.halfWidth * 2, c.thickness, chuteLength),
    chuteMaterial,
  );
  chute.position.set(0, (c.frontY + c.backY) / 2 + c.thickness / 2, (c.frontZ + c.backZ) / 2);
  chute.rotation.x = -Math.atan2(c.backY - c.frontY, c.backZ - c.frontZ);
  scene.add(chute);

  // 側面レール（奥側のみ。手前は開いていてロスト溝になる）
  const railBottom = f.lowerTableY;
  const railHeight = f.railTopY - railBottom;
  const railDepth = f.railBackZ - f.railFrontZ;
  for (const sign of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.02, railHeight, railDepth), benchMaterial);
    rail.position.set(
      sign * (f.halfWidth + 0.01),
      railBottom + railHeight / 2,
      (f.railBackZ + f.railFrontZ) / 2,
    );
    scene.add(rail);
  }

  // 奥の固定壁
  const backWall = new THREE.Mesh(
    new THREE.BoxGeometry(f.halfWidth * 2 + 0.04, f.wallHeight, 0.02),
    benchMaterial,
  );
  backWall.position.set(0, f.shelfTopY + f.wallHeight / 2, f.backWallZ);
  scene.add(backWall);

  // ロスト溝（左右）の見た目。落ちたストーンが消える暗がり
  const gutterMaterial = new THREE.MeshStandardMaterial({ color: 0x1c1109, roughness: 1 });
  for (const sign of [-1, 1]) {
    const gutter = new THREE.Mesh(
      new THREE.BoxGeometry(0.12, 0.02, f.backZ - f.payoutZ),
      gutterMaterial,
    );
    gutter.position.set(sign * (f.halfWidth + 0.06), f.lowerTableY - 0.06, (f.backZ + f.payoutZ) / 2);
    scene.add(gutter);
  }

  // ---- プッシャー -----------------------------------------------------
  const pusherMaterial = new THREE.MeshStandardMaterial({
    map: woodTexture,
    color: 0x8f6440,
    roughness: 0.6,
    metalness: 0.05,
  });
  // 物理側の複合形状（板＋後端リップ）に合わせて Group で組む
  const pusherMesh = new THREE.Mesh(
    new THREE.BoxGeometry(f.halfWidth * 2, BALANCE.pusher.height, BALANCE.pusher.depth),
    pusherMaterial,
  );
  pusherMesh.position.y = -BALANCE.pusher.height / 2;
  pusherMesh.castShadow = true;

  const pusherGroup = new THREE.Group();
  pusherGroup.add(pusherMesh);
  pusherGroup.position.set(0, f.shelfTopY, BALANCE.pusher.baseZ);
  scene.add(pusherGroup);

  // ---- ストーブ（手前・ペイアウトの落下先） ---------------------------
  const stoveMaterial = new THREE.MeshStandardMaterial({ color: 0x2b2b30, roughness: 0.55, metalness: 0.6 });
  const stove = new THREE.Mesh(new THREE.BoxGeometry(f.halfWidth * 2 + 0.04, 0.12, 0.16), stoveMaterial);
  stove.position.set(0, f.lowerTableY - 0.09, f.payoutZ - 0.09);
  scene.add(stove);

  const stoveFire = new THREE.Mesh(
    new THREE.PlaneGeometry(f.halfWidth * 1.8, 0.1),
    new THREE.MeshBasicMaterial({
      color: 0xff7a2a,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }),
  );
  stoveFire.position.set(0, f.lowerTableY - 0.05, f.payoutZ - 0.02);
  stoveFire.rotation.x = -Math.PI / 8;
  scene.add(stoveFire);

  // ---- ストーン（InstancedMesh。個別 Mesh では 120 個で描画が破綻する） ----
  const s = BALANCE.physics.stone;
  const stoneMaterial = new THREE.MeshStandardMaterial({
    color: 0x5c5c62,
    roughness: 0.9,
    metalness: 0.1,
    emissive: new THREE.Color(0xff4400),
    emissiveIntensity: 0,
  });
  const stoneMesh = new THREE.InstancedMesh(
    new THREE.CylinderGeometry(s.radius, s.radius * 0.92, s.thickness, 12),
    stoneMaterial,
    MAX_STONE_INSTANCES,
  );
  stoneMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  stoneMesh.count = 0;
  stoneMesh.frustumCulled = false;
  stoneMesh.castShadow = true;
  scene.add(stoneMesh);

  const itemGroup = new THREE.Group();
  scene.add(itemGroup);

  // ---- 照明 -----------------------------------------------------------
  const ambient = new THREE.AmbientLight(0xffc79a, 0.6);
  scene.add(ambient);

  const roomLight = new THREE.PointLight(0xffd6a5, 2.2, 4, 1.4);
  roomLight.position.set(0.15, 0.5, -0.15);
  scene.add(roomLight);

  const stoveGlow = new THREE.PointLight(0xff5a1e, 0.6, 1.0, 2);
  stoveGlow.position.set(0, f.lowerTableY + 0.02, f.payoutZ - 0.05);
  scene.add(stoveGlow);

  return {
    scene,
    stoneMesh,
    itemGroup,
    pusherMesh: pusherGroup,
    stoveGlow,
    stoveFire,
    roomLight,
    ambient,
    wallMaterial,
    stoneMaterial,
  };
}

/** アイテムの3D表現。ロウリュ＝柄杓（円柱）、オロポ＝缶。 */
export function buildItemMesh(color: number, modelKey: string): THREE.Mesh {
  const i = BALANCE.physics.item;
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: 0.35,
    metalness: 0.4,
    emissive: new THREE.Color(color),
    emissiveIntensity: 0.35,
  });
  const geometry =
    modelKey === 'can'
      ? new THREE.CylinderGeometry(i.radius * 0.72, i.radius * 0.72, i.thickness * 2.4, 14)
      : new THREE.CylinderGeometry(i.radius, i.radius, i.thickness, 14);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  return mesh;
}

/**
 * 木目テクスチャを Canvas で生成する。外部画像を読まないための手続き生成。
 */
function makeWoodTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#c69a6b';
    ctx.fillRect(0, 0, size, size);
    for (let i = 0; i < 70; i += 1) {
      const y = Math.random() * size;
      const h = 1 + Math.random() * 3;
      const shade = 0.06 + Math.random() * 0.12;
      ctx.fillStyle = `rgba(90, 55, 25, ${shade})`;
      ctx.fillRect(0, y, size, h);
    }
    // 板の継ぎ目
    ctx.fillStyle = 'rgba(60, 34, 14, 0.5)';
    for (let y = 0; y < size; y += 64) ctx.fillRect(0, y, size, 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(2, 2);
  return texture;
}
