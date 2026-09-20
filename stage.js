/* ------------------------------------------------------------------ *
 * stage.js — the room, the props, the camera and the render pipeline.
 * The actors live in fly.js.
 * ------------------------------------------------------------------ */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { makeFly, updateFly, setPose, Spring } from "/fly.js";

const BAR_TOP_Y = 1.04;
const BAR_FRONT_Z = -0.30;
const STOOL_Z = 0.22;
const SEAT_Y = 0.96;
/* High enough that the legs are visibly extended and there is daylight under
   the body. Any lower and a fly reads as lying on the stool, not sitting. */
const BODY_Y = 1.27;
const HOME_X = { female: -0.95, male: 0.95 };
const TINT = { female: 0xff4d8a, male: 0x5a9cff };

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const rnd = (a, b) => a + Math.random() * (b - a);

/* ------------------------------------------------------------------ *
 * textures
 * ------------------------------------------------------------------ */
function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function woodTex(base, light, dark) {
  const t = canvasTex(1024, 1024, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      const y = (i / 26) * h + Math.random() * 6;
      const grd = g.createLinearGradient(0, y - 18, 0, y + 18);
      grd.addColorStop(0, dark); grd.addColorStop(0.5, light); grd.addColorStop(1, dark);
      g.fillStyle = grd;
      g.fillRect(0, y - 18, w, 36);
    }
    for (let i = 0; i < 240; i++) {
      g.strokeStyle = "rgba(18,9,4," + (0.05 + Math.random() * 0.22) + ")";
      g.lineWidth = 0.6 + Math.random() * 1.8;
      const y = Math.random() * h;
      g.beginPath();
      g.moveTo(0, y);
      g.bezierCurveTo(w * 0.3, y + (Math.random() - 0.5) * 26, w * 0.7, y + (Math.random() - 0.5) * 26, w, y + (Math.random() - 0.5) * 14);
      g.stroke();
    }
    for (let i = 0; i < 7; i++) {
      const x = Math.random() * w, y = Math.random() * h, r = 14 + Math.random() * 22, rot = Math.random();
      for (let k = 6; k > 0; k--) {
        g.strokeStyle = "rgba(22,11,5,0.22)"; g.lineWidth = 1.4;
        g.beginPath();
        g.ellipse(x, y, r * (k / 6), r * 0.55 * (k / 6), rot, 0, Math.PI * 2);
        g.stroke();
      }
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function neonSignTex() {
  return canvasTex(1024, 256, (g, w, h) => {
    g.fillStyle = "#07030a"; g.fillRect(0, 0, w, h);
    g.textBaseline = "middle";
    const glow = (text, x, y, size, color) => {
      g.font = "bold " + size + "px Georgia, serif";
      g.shadowColor = color; g.fillStyle = color;
      for (let i = 4; i > 0; i--) { g.shadowBlur = i * 14; g.fillText(text, x, y); }
      g.shadowBlur = 0; g.fillStyle = "#fff4f6"; g.fillText(text, x, y);
    };
    glow("МУХА", 52, 118, 104, "#ff2d55");
    glow("BAR", 585, 114, 92, "#ffb23d");
    g.shadowColor = "#39d6ff"; g.shadowBlur = 26;
    g.strokeStyle = "#39d6ff"; g.lineWidth = 5;
    g.strokeRect(24, 26, w - 48, h - 52);
  });
}

function sparkTex() {
  return canvasTex(64, 64, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grd.addColorStop(0, "rgba(255,255,255,1)");
    grd.addColorStop(0.28, "rgba(255,214,130,0.85)");
    grd.addColorStop(1, "rgba(255,150,40,0)");
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  });
}

/** Chrome in a dive bar should reflect red neon and a warm lamp, not a
 *  grey studio. Tiny scene → PMREM → scene.environment. */
function barEnvironment(renderer) {
  const s = new THREE.Scene();
  s.background = new THREE.Color(0x0a0608);
  /* A dim enclosing dome so nothing reflects pure black, plus a few big
     soft colour sources. Deliberately faint: this map exists to give chrome
     and glass something coloured to catch, not to light the room.
     Panels must be large and the map heavily blurred, or their rectangular
     outlines show up as hard square highlights on every curved surface. */
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(10, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x100a0c, side: THREE.BackSide })
  );
  s.add(dome);
  const panel = (hex, mul, w, h, pos) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(mul), side: THREE.DoubleSide })
    );
    m.position.set(pos[0], pos[1], pos[2]);
    m.lookAt(0, 1.2, 0);
    s.add(m);
  };
  panel(0xffc98a, 1.05, 9, 9, [0, 6, 0]);
  panel(0xff2d55, 0.45, 9, 7, [-6.5, 2, -1]);
  panel(0x3d7dff, 0.26, 9, 7, [6.5, 2, -1]);
  panel(0xffb23d, 0.22, 9, 5, [0, 2, -6.5]);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(s, 0.45);
  pmrem.dispose();
  return rt.texture;
}

/* grain + vignette + a whisper of chromatic aberration + a hit flash */
const FilmShader = {
  uniforms: {
    tDiffuse: { value: null },
    time: { value: 0 },
    vignette: { value: 1.15 },
    grain: { value: 0.028 },
    aberration: { value: 0.5 },
    flash: { value: 0 },
  },
  vertexShader: [
    "varying vec2 vUv;",
    "void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
  ].join("\n"),
  fragmentShader: [
    "uniform sampler2D tDiffuse;",
    "uniform float time, vignette, grain, aberration, flash;",
    "varying vec2 vUv;",
    "void main(){",
    "  vec2 c = vUv - 0.5;",
    "  float r2 = dot(c,c);",
    "  vec2 off = c * r2 * aberration * 0.06;",
    "  vec3 col;",
    "  col.r = texture2D(tDiffuse, vUv - off).r;",
    "  col.g = texture2D(tDiffuse, vUv).g;",
    "  col.b = texture2D(tDiffuse, vUv + off).b;",
    "  col *= mix(1.0, 0.40, smoothstep(0.04, 0.60, r2 * vignette));",
    "  float n = fract(sin(dot(vUv * 1024.0 + fract(time) * 91.7, vec2(12.9898,78.233))) * 43758.5453);",
    "  col += (n - 0.5) * grain;",
    "  col += flash;",
    "  gl_FragColor = vec4(col, 1.0);",
    "}",
  ].join("\n"),
};

/* ------------------------------------------------------------------ *
 * camera shots. `off` is relative to the actor and mirrored so the
 * camera always stays on the outside of whoever is acting.
 * ------------------------------------------------------------------ */
/* Every shot keeps the whole bar in frame — the camera never cuts to a
   close-up. `pos` is absolute with x mirrored toward whichever fly is acting,
   so the angle shifts and the height changes with the action while the set
   stays readable. The follow spot is what picks the actor out, not a zoom. */
const SHOTS = {
  idle:   { pos: [2.65, 2.05, 4.10], look: [0, 1.36, -0.34], fov: 36 },
  wait:   { pos: [2.65, 2.05, 4.10], look: [0, 1.36, -0.34], fov: 36 },
  drink:  { pos: [2.45, 1.82, 3.70], look: [0, 1.32, -0.30], fov: 34 },
  spin:   { pos: [2.10, 2.18, 3.80], look: [0, 1.42, -0.46], fov: 34 },
  win:    { pos: [2.20, 1.58, 3.50], look: [0, 1.44, -0.34], fov: 33 },
  lose:   { pos: [2.55, 1.90, 3.75], look: [0, 1.28, -0.32], fov: 34 },
  steal:  { pos: [2.25, 2.45, 3.85], look: [0, 1.40, -0.40], fov: 35 },
  beg:    { pos: [2.45, 1.78, 3.65], look: [0, 1.34, -0.28], fov: 34 },
  nap:    { pos: [2.60, 1.80, 3.80], look: [0, 1.28, -0.28], fov: 34 },
  borrow: { pos: [2.50, 2.10, 3.90], look: [0, 1.38, -0.42], fov: 35 },
  /* the floor shots lean harder toward the actor and sit lower, because the
     fly is down at y≈0.15 and the default framing leaves it off the bottom */
  /* swung inboard as well as down: the deep table sits at x 2.15 z 1.5 and a
     shot from further out looks straight through it */
  fall:   { pos: [1.62, 1.45, 4.10], look: [0, 0.62, 0.34], fov: 36, bias: 0.72 },
  down:   { pos: [1.55, 1.30, 4.00], look: [0, 0.48, 0.36], fov: 35, bias: 0.78 },
  climb:  { pos: [1.80, 1.62, 4.00], look: [0, 0.95, 0.28], fov: 35, bias: 0.50 },
  /* the rest of the evening */
  /* the two face-forward beats: in close, and low enough to be eye to eye */
  groom:  { pos: [1.95, 1.50, 3.20], look: [0, 1.32, 0.18], fov: 29, bias: 0.72 },
  work:   { pos: [2.35, 1.96, 3.80], look: [0, 1.40, -0.34], fov: 34, bias: 0.40 },
  /* the search happens out in front of the stools, so the camera has to come
     round and down to it or the stool leg stands in the way */
  /* Down near the boards rather than looking at them from stool height: the
     search circuit carries the fly across the front of its own stool, and
     from up high that overlap reads as a fly perched on the seat. Almost at
     floor level there is no doubt about where it is. Swung off the stool's
     x as well, so the leg never lands on the fly; far enough inboard that
     the chair back at x≈1.46 z≈1.5 stays off the sight line. */
  scrounge: { pos: [1.50, 0.82, 3.70], look: [0, 0.20, 0.70], fov: 36, bias: 0.85 },
  /* tall and wide: the fly leaves the counter entirely and the shot has to
     hold both the bulb at y 2.4 and the bar it took off from */
  lamp:   { pos: [3.15, 2.05, 5.00], look: [0, 1.95, -0.30], fov: 38, bias: 0.24 },
  /* the widest shot in the game, because the joke is the distance between
     the fly and the bar it is supposed to be sitting at */
  ceiling:{ pos: [3.05, 1.82, 4.55], look: [0, 2.52, 0.25], fov: 44, bias: 0.20 },
  /* from inboard, looking back along the bar. The extended wing points at
     the fly being sung to, which from the usual outboard angle is straight
     away from camera and behind the body. */
  sing:   { pos: [-0.55, 1.72, 3.90], look: [0.30, 1.32, -0.12], fov: 38, bias: 0.26 },
  /* both flies, and the 1.9 metres of bar between them */
  toast:  { pos: [0.30, 1.92, 5.35], look: [0, 1.36, -0.30], fov: 33, bias: 0.0 },
  /* wide enough to hold both stools, because the whole beat is the crossing */
  shove:  { pos: [1.35, 1.88, 4.85], look: [0, 1.36, -0.20], fov: 34, bias: 0.16 },
  bubble: { pos: [1.90, 1.50, 3.35], look: [0, 1.28, 0.22], fov: 30, bias: 0.72 },
};
/* how far the framing leans toward the acting fly — small, so the other fly
   never falls out of frame */
const BIAS = 0.18;

/* ================================================================== *
 * bootStage
 * ================================================================== */
export function bootStage(canvas, getState, getHoldMs) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.72;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070507);
  scene.fog = new THREE.FogExp2(0x070507, 0.07);

  try { scene.environment = barEnvironment(renderer); } catch (e) { /* reflections are optional */ }

  const camera = new THREE.PerspectiveCamera(36, 1, 0.08, 60);
  const camHome = new THREE.Vector3(2.65, 2.05, 4.10);
  const lookHome = new THREE.Vector3(0, 1.36, -0.34);
  camera.position.copy(camHome);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.copy(lookHome);
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 0.9;
  controls.maxDistance = 9;
  let grabbedAt = -1e9;
  const noteGrab = () => { grabbedAt = performance.now(); };
  controls.addEventListener("start", noteGrab);
  controls.addEventListener("end", noteGrab);

  /* ---------------- material helpers ---------------- */
  const wood = woodTex("#3a2418", "#523420", "#20120a");
  const woodDark = woodTex("#2a1810", "#3c2415", "#150b06");
  const std = (color, extra) => new THREE.MeshStandardMaterial(Object.assign({ color: color, roughness: 0.6, envMapIntensity: 0.55 }, extra || {}));
  const phys = (color, extra) => new THREE.MeshPhysicalMaterial(Object.assign({ color: color, roughness: 0.4, envMapIntensity: 0.8 }, extra || {}));
  const chrome = () => new THREE.MeshStandardMaterial({ color: 0xbfc6d0, metalness: 0.95, roughness: 0.22, envMapIntensity: 1.5 });
  const brass = () => new THREE.MeshStandardMaterial({ color: 0xd4a44a, metalness: 0.92, roughness: 0.28, envMapIntensity: 1.6 });
  const repeatMap = (src, x, y) => { const m = src.clone(); m.needsUpdate = true; m.repeat.set(x, y); return m; };

  function put(mesh, x, y, z, parent) {
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    (parent || scene).add(mesh);
    return mesh;
  }

  /* ---------------- lights ---------------- */
  scene.add(new THREE.HemisphereLight(0xffb98a, 0x120a12, 0.12));

  const key = new THREE.SpotLight(0xffd9ad, 16, 14, 0.62, 0.6, 1.4);
  key.position.set(1.9, 4.2, 2.6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.bias = -0.0008;
  key.shadow.normalBias = 0.022;
  key.shadow.camera.near = 0.6;
  key.shadow.camera.far = 12;
  key.target.position.set(0, 1.0, -0.2);
  scene.add(key, key.target);

  const fill = new THREE.PointLight(0x7a5088, 1.4, 9, 2);
  fill.position.set(-2.4, 1.7, 2.2);
  scene.add(fill);

  const rimLight = new THREE.DirectionalLight(0x7fd8ff, 0.4);
  rimLight.position.set(-1.6, 2.2, -3.2);
  scene.add(rimLight);

  const neonL = new THREE.PointLight(0xff2d55, 2.6, 7, 2); neonL.position.set(-1.6, 2.5, -1.9); scene.add(neonL);
  const neonR = new THREE.PointLight(0x39d6ff, 1.3, 6, 2); neonR.position.set(1.7, 2.4, -1.9); scene.add(neonR);
  const lampLight = new THREE.PointLight(0xffc27a, 4.2, 6, 2); lampLight.position.set(0, 2.3, -0.1); scene.add(lampLight);

  /* Follows whoever is acting. This is the readability trick: your eye
     always knows where to go, even when the beats are short. */
  const actorLight = new THREE.SpotLight(0xfff0d0, 0, 7, 0.4, 0.85, 1.5);
  actorLight.position.set(0, 3.1, 1.0);
  scene.add(actorLight, actorLight.target);

  /* signature rim per fly, so they read apart even in silhouette */
  const tintLight = {
    female: new THREE.PointLight(TINT.female, 0.5, 1.4, 2),
    male: new THREE.PointLight(TINT.male, 0.5, 1.4, 2),
  };
  scene.add(tintLight.female, tintLight.male);

  /* ---------------- room ---------------- */
  const floor = new THREE.Mesh(new THREE.CircleGeometry(12, 64), new THREE.MeshStandardMaterial({
    map: repeatMap(wood, 5, 5), color: 0x5f4232, roughness: 0.7, metalness: 0.08, envMapIntensity: 0.35,
  }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const rug = new THREE.Mesh(new THREE.CircleGeometry(2.4, 56), std(0x4a1512, { roughness: 0.95, envMapIntensity: 0.1 }));
  rug.rotation.x = -Math.PI / 2; rug.position.y = 0.011; rug.receiveShadow = true;
  scene.add(rug);

  const wallMap = repeatMap(woodDark, 4, 2);
  const backWall = put(new THREE.Mesh(new THREE.BoxGeometry(7.5, 3.6, 0.15), new THREE.MeshStandardMaterial({
    map: wallMap, color: 0x6a4030, roughness: 0.85, envMapIntensity: 0.22,
  })), 0, 1.8, -2.2);
  backWall.castShadow = false;
  [-3.6, 3.6].forEach((x) => {
    put(new THREE.Mesh(new THREE.BoxGeometry(0.15, 3.6, 4.6), new THREE.MeshStandardMaterial({
      map: repeatMap(woodDark, 3, 2), color: 0x4a2c20, roughness: 0.9, envMapIntensity: 0.18,
    })), x, 1.8, -0.3).castShadow = false;
  });

  const mirror = put(new THREE.Mesh(new THREE.PlaneGeometry(3.6, 0.85), new THREE.MeshStandardMaterial({
    color: 0x2b3840, metalness: 1.0, roughness: 0.09, envMapIntensity: 2.2,
  })), 0, 2.02, -2.11);
  mirror.castShadow = false;
  [1.57, 2.47].forEach((y) => { put(new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.05, 0.06), brass()), 0, y, -2.09).castShadow = false; });

  const shelfMat = new THREE.MeshStandardMaterial({ map: repeatMap(woodDark, 3, 1), color: 0x7a5038, roughness: 0.5, envMapIntensity: 0.4 });
  put(new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.07, 0.3), shelfMat), 0, 1.58, -1.95);
  put(new THREE.Mesh(new THREE.BoxGeometry(4.0, 0.07, 0.3), shelfMat), 0, 1.16, -1.95);

  const sign = put(new THREE.Mesh(new THREE.PlaneGeometry(2.3, 0.575), new THREE.MeshBasicMaterial({
    map: neonSignTex(), toneMapped: false,
  })), 0, 2.78, -2.1);
  sign.castShadow = false;

  /* bottles */
  const bottleCols = [0x1d5c2e, 0x7a2010, 0xd0a94e, 0x1f4a78, 0x6b1226, 0x2a7a58, 0x8a6b26, 0x3c1030, 0x0f2a1c, 0xb4732a, 0x123048];
  function makeBottle(x, y, z, i) {
    const g = new THREE.Group();
    const h = 0.22 + (i % 5) * 0.055;
    const mat = new THREE.MeshPhysicalMaterial({
      color: bottleCols[i % bottleCols.length], roughness: 0.08, metalness: 0,
      transmission: 0.7, thickness: 0.08, ior: 1.45, envMapIntensity: 1.6,
      transparent: true, opacity: 0.95,
    });
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.05, h, 16), mat);
    const shoulder = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.06, 16), mat);
    shoulder.position.y = h / 2 + 0.028;
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.018, 0.1, 10), mat);
    neck.position.y = h / 2 + 0.105;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.026, 10), i % 3 ? brass() : std(0xc0a070));
    cap.position.y = h / 2 + 0.165;
    const label = new THREE.Mesh(new THREE.CylinderGeometry(0.0455, 0.0455, h * 0.42, 16, 1, true),
      std(i % 2 ? 0xe8dcc0 : 0x201014, { side: THREE.DoubleSide, roughness: 0.85, envMapIntensity: 0.2 }));
    g.add(body, shoulder, neck, cap, label);
    g.position.set(x, y + h / 2, z);
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    scene.add(g);
  }
  for (let i = 0; i < 11; i++) makeBottle(-1.7 + i * 0.34, 1.615, -1.95, i);
  for (let i = 0; i < 9; i++) makeBottle(-1.35 + i * 0.34, 1.195, -1.98, i + 4);

  /* hanging stemware */
  const rackBar = put(new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 2.4, 10), chrome()), 0, 2.02, -0.95);
  rackBar.rotation.z = Math.PI / 2;
  const stemMat = new THREE.MeshPhysicalMaterial({
    color: 0xdff0ff, roughness: 0.04, transmission: 0.9, thickness: 0.02, ior: 1.5,
    transparent: true, opacity: 0.6, envMapIntensity: 2.0, side: THREE.DoubleSide,
  });
  for (let i = 0; i < 9; i++) {
    const g = new THREE.Group();
    const cup = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.1, 14, 1, true), stemMat);
    cup.rotation.x = Math.PI;
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.08, 6), stemMat);
    stem.position.y = 0.09;
    g.add(cup, stem);
    g.position.set(-1.0 + i * 0.25, 1.9, -0.95);
    scene.add(g);
  }

  /* the counter */
  put(new THREE.Mesh(new THREE.BoxGeometry(5.0, 0.98, 1.15), new THREE.MeshStandardMaterial({
    map: repeatMap(woodDark, 4, 1), color: 0x7a4a30, roughness: 0.55, envMapIntensity: 0.5,
  })), 0, 0.49, -0.95);
  put(new THREE.Mesh(new THREE.BoxGeometry(5.2, 0.08, 1.35), new THREE.MeshPhysicalMaterial({
    color: 0x2a1408, roughness: 0.12, clearcoat: 1.0, clearcoatRoughness: 0.08, envMapIntensity: 1.5,
  })), 0, BAR_TOP_Y - 0.04, -0.95);
  const barEdge = put(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 5.2, 16), brass()), 0, BAR_TOP_Y - 0.045, BAR_FRONT_Z);
  barEdge.rotation.z = Math.PI / 2;
  const footRail = put(new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 4.6, 12), brass()), 0, 0.26, -0.18);
  footRail.rotation.z = Math.PI / 2;

  /* pendant lamp with a visible cone */
  const lamp = new THREE.Group();
  const shade = new THREE.Mesh(new THREE.ConeGeometry(0.32, 0.26, 26, 1, true), std(0x6e2a14, {
    side: THREE.DoubleSide, roughness: 0.38, metalness: 0.4, emissive: 0x3a1608, emissiveIntensity: 0.6,
  }));
  shade.castShadow = true;
  const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 10), new THREE.MeshBasicMaterial({ color: 0xffdca8, toneMapped: false }));
  bulb.position.y = -0.1;
  const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1.0, 6), std(0x0e0e0e));
  cord.position.y = 0.6;
  /* A camera-facing glow around the bulb instead of a cone of geometry. Cone
     meshes read as a solid pyramid hanging in the room, which is worse than
     having no visible shaft at all. */
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: sparkTex(), color: 0xffc98a, transparent: true, opacity: 0.5,
    depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  }));
  halo.scale.setScalar(1.1);
  halo.position.y = -0.1;
  lamp.add(shade, bulb, cord, halo);
  lamp.position.set(0, 2.5, -0.1);
  lamp.userData.knock = 0;      // set to 1 when a fly flies into it
  scene.add(lamp);

  /* A ceiling. The room never needed one until a fly started walking on it,
     and then it needed one badly: without a surface up there the pose reads
     as hovering. Pressed tin, dark, lit almost entirely by the pendant it
     hangs above, so it stays a silhouette backdrop rather than a bright lid. */
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(9, 7), new THREE.MeshStandardMaterial({
    map: repeatMap(woodDark, 9, 7), color: 0x3a2a26, roughness: 0.82, metalness: 0.2,
    envMapIntensity: 0.3, side: THREE.DoubleSide,
  }));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, 2.98, 0.1);
  ceiling.receiveShadow = true;
  scene.add(ceiling);
  /* Two uplights, and they matter more than they look: a fly up there is
     otherwise a black shape on a black lid. The forward one is over the
     stools, which is where the ceiling walk actually happens. */
  [[0, 2.60, -0.3, 2.2], [0, 2.55, 0.7, 2.6]].forEach(([x, y, z, i]) => {
    const l = new THREE.PointLight(0xffb478, i, 3.4, 2);
    l.position.set(x, y, z);
    scene.add(l);
  });

  /* a slow ceiling fan; its shadow sweeping the counter makes the room breathe */
  const fan = new THREE.Group();
  fan.add(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.08, 14), brass()));
  for (let i = 0; i < 4; i++) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.012, 0.16), std(0x3a2418, { roughness: 0.8 }));
    const a = (i / 4) * Math.PI * 2;
    blade.position.set(Math.cos(a) * 0.36, -0.02, Math.sin(a) * 0.36);
    blade.rotation.y = -a;
    blade.rotation.z = 0.16;
    blade.castShadow = true;
    fan.add(blade);
  }
  fan.position.set(-1.4, 3.05, 0.6);
  scene.add(fan);

  /* stools */
  function makeStool(x) {
    const g = new THREE.Group();
    const met = chrome();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.09, 0.9, 16), met);
    pole.position.y = 0.45;
    /* wide enough that a fly sits on the seat rather than over it, matte
       enough that the leather does not blow out to pink under the lamp */
    const seat = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.4, 0.08, 30), phys(0x6d2015, {
      roughness: 0.72, clearcoat: 0.12, clearcoatRoughness: 0.7, envMapIntensity: 0.16,
    }));
    seat.position.y = SEAT_Y - 0.04;
    const piping = new THREE.Mesh(new THREE.TorusGeometry(0.385, 0.017, 8, 30), std(0x280b07, { roughness: 0.75, envMapIntensity: 0.12 }));
    piping.rotation.x = Math.PI / 2;
    piping.position.y = SEAT_Y - 0.044;
    const button = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), std(0x40120c, { envMapIntensity: 0.2 }));
    button.position.y = SEAT_Y - 0.008;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.24, 0.019, 8, 24), met);
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.32;
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.23, 0.27, 0.04, 20), met);
    base.position.y = 0.02;
    g.add(pole, seat, piping, button, ring, base);
    g.position.set(x, 0, STOOL_Z);
    g.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    scene.add(g);
  }
  makeStool(HOME_X.female);
  makeStool(HOME_X.male);

  /* ---------------- the room behind them ----------------
     Only ever seen in the reverse angles, but without it those shots read
     as a fly floating in fog. */
  const jukebox = new THREE.Group();
  const jbBody = new THREE.Mesh(new THREE.BoxGeometry(0.66, 1.25, 0.44), phys(0x3a1c14, {
    roughness: 0.3, clearcoat: 0.8, envMapIntensity: 0.9,
  }));
  jbBody.position.y = 0.63;
  const jbArch = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.44, 22, 1, false, 0, Math.PI), new THREE.MeshStandardMaterial({
    color: 0x2a0e14, emissive: 0xff3366, emissiveIntensity: 0.9, roughness: 0.3,
  }));
  jbArch.position.y = 1.25;
  jbArch.rotation.x = Math.PI / 2;
  jbArch.rotation.z = Math.PI;
  const jbGrille = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.3, 0.03), std(0xc8a860, { metalness: 0.5, roughness: 0.5 }));
  jbGrille.position.set(0, 0.62, 0.23);
  jukebox.add(jbBody, jbArch, jbGrille);
  jukebox.position.set(-2.35, 0, 1.15);
  jukebox.rotation.y = 0.5;
  jukebox.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  scene.add(jukebox);
  const jukeGlow = new THREE.PointLight(0xff3366, 1.1, 2.6, 2);
  jukeGlow.position.set(-2.3, 1.35, 1.35);
  scene.add(jukeGlow);

  /* a table and two chairs, deep and mostly in shadow */
  const table = new THREE.Group();
  const tTop = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.05, 24), std(0x36210f, { roughness: 0.5 }));
  tTop.position.y = 0.72;
  const tPole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.72, 12), chrome());
  tPole.position.y = 0.36;
  const tFoot = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.26, 0.03, 18), chrome());
  tFoot.position.y = 0.015;
  table.add(tTop, tPole, tFoot);
  [[-0.62, 0.3], [0.6, -0.25]].forEach((c) => {
    const ch = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.05, 0.32), std(0x3a1a12, { roughness: 0.7 }));
    ch.position.set(c[0], 0.46, c[1]);
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.4, 0.04), std(0x3a1a12, { roughness: 0.7 }));
    back.position.set(c[0], 0.66, c[1] + (c[1] > 0 ? 0.14 : -0.14));
    table.add(ch, back);
  });
  table.position.set(2.15, 0, 1.5);
  table.rotation.y = -0.4;
  table.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(table);

  /* a low bulb over the table and a green exit sign on the far wall */
  const tableBulb = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffca88, toneMapped: false }));
  tableBulb.position.set(2.15, 1.85, 1.5);
  scene.add(tableBulb);
  const tableLight = new THREE.PointLight(0xffb070, 1.6, 3.2, 2);
  tableLight.position.set(2.15, 1.8, 1.5);
  scene.add(tableLight);
  const exitSign = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.16), new THREE.MeshBasicMaterial({
    color: 0x2bff88, toneMapped: false, transparent: true, opacity: 0.85,
  }));
  exitSign.position.set(3.4, 2.1, 1.1);
  exitSign.rotation.y = -Math.PI / 2;
  scene.add(exitSign);
  const exitGlow = new THREE.PointLight(0x2bff88, 0.7, 2.0, 2);
  exitGlow.position.set(3.25, 2.05, 1.1);
  scene.add(exitGlow);

  /* ---------------- slot machine ---------------- */
  const SLOT_Z = -0.72;
  function makeSlot() {
    const g = new THREE.Group();
    const met = chrome();
    const cab = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.05, 0.44), phys(0x1c1310, {
      roughness: 0.28, metalness: 0.5, clearcoat: 0.6, envMapIntensity: 1.1,
    }));
    cab.position.y = 0.52;
    const trim = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.05, 0.48), brass());
    trim.position.y = 1.05;
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.34, 0.02), new THREE.MeshPhysicalMaterial({
      color: 0xbfe0ff, transmission: 0.9, thickness: 0.01, roughness: 0.03,
      transparent: true, opacity: 0.3, envMapIntensity: 2,
    }));
    glass.position.set(0, 0.6, 0.23);
    const marquee = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.17, 0.05), new THREE.MeshStandardMaterial({
      color: 0x2a1000, emissive: 0xffa022, emissiveIntensity: 1.4,
    }));
    marquee.position.set(0, 0.92, 0.19);
    const tray = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.06, 0.18), met);
    tray.position.set(0, 0.14, 0.28);

    const lever = new THREE.Group();
    const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.4, 10), met);
    arm.position.y = 0.2;
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 12), phys(0xc4121c, {
      roughness: 0.15, clearcoat: 1, emissive: 0x400004, emissiveIntensity: 0.5,
    }));
    knob.position.y = 0.42;
    lever.add(arm, knob);
    lever.position.set(0.47, 0.5, 0.0);

    const lamps = [];
    for (let i = 0; i < 7; i++) {
      const col = i % 2 ? 0xff2d55 : 0xffc23d;
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), new THREE.MeshStandardMaterial({
        color: col, emissive: col, emissiveIntensity: 1.0,
      }));
      b.position.set(-0.33 + (i / 6) * 0.66, 1.08 + Math.sin((i / 6) * Math.PI) * 0.035, 0.17);
      g.add(b);
      lamps.push(b);
    }

    /* 8-sided drums, so symbols really roll past the window */
    const symbolCols = [0xe0242c, 0xf0b93a, 0x2f6fed, 0x34c17a, 0xf05a9a, 0xf5efe0, 0x9b5de5, 0xffd84a];
    const reels = [];
    [-0.2, 0, 0.2].forEach((x, ri) => {
      const reel = new THREE.Group();
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.112, 0.112, 0.165, 20), std(0xe8e2d4, { roughness: 0.6 }));
      drum.rotation.z = Math.PI / 2;
      reel.add(drum);
      for (let s = 0; s < 8; s++) {
        const col = symbolCols[(s + ri * 3) % 8];
        const face = new THREE.Mesh(new THREE.BoxGeometry(0.145, 0.072, 0.016), new THREE.MeshStandardMaterial({
          color: col, emissive: col, emissiveIntensity: 0.3, roughness: 0.45,
        }));
        const a = (s / 8) * Math.PI * 2;
        face.position.set(0, Math.cos(a) * 0.115, Math.sin(a) * 0.115);
        face.rotation.x = -a;
        reel.add(face);
      }
      reel.position.set(x, 0.6, 0.16);
      g.add(reel);
      reels.push(reel);
    });

    g.add(cab, trim, glass, marquee, tray, lever);
    g.position.set(0, BAR_TOP_Y, SLOT_Z);
    g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    g.userData = {
      reels, lever, lamps, marquee, spinT: 0, won: false, jackpot: false,
      speeds: [0, 0, 0], stopAt: [0, 0, 0], leverSpring: new Spring(0, 110, 12),
    };
    scene.add(g);
    return g;
  }
  const slot = makeSlot();
  const slotGlow = new THREE.PointLight(0xffb040, 0, 2.4, 2);
  slotGlow.position.set(0, BAR_TOP_Y + 0.65, SLOT_Z + 0.4);
  scene.add(slotGlow);

  /* ---------------- glasses ---------------- */
  const GLASS_Z = -0.42;
  function makeGlass(x) {
    const g = new THREE.Group();
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.046, 0.15, 22, 1, true), new THREE.MeshPhysicalMaterial({
      color: 0xdff0ff, roughness: 0.02, transmission: 0.95, thickness: 0.012, ior: 1.52,
      transparent: true, opacity: 0.4, side: THREE.DoubleSide, envMapIntensity: 2.4,
    }));
    shell.position.y = 0.075;
    const bottom = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.046, 0.02, 20), shell.material);
    bottom.position.y = 0.01;
    const liquid = new THREE.Mesh(new THREE.CylinderGeometry(0.049, 0.043, 0.1, 20), new THREE.MeshPhysicalMaterial({
      color: 0xd8600f, roughness: 0.08, transmission: 0.45, thickness: 0.05, ior: 1.36,
      transparent: true, opacity: 0.92, emissive: 0x5a1e00, emissiveIntensity: 0.5, envMapIntensity: 1.6,
    }));
    liquid.position.y = 0.06;
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.004, 6, 22), shell.material);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.15;
    g.add(shell, bottom, liquid, rim);
    g.position.set(x, BAR_TOP_Y, GLASS_Z);
    g.userData = {
      liquid, sip: 0, home: new THREE.Vector3(x, BAR_TOP_Y, GLASS_Z),
      fill: new Spring(1, 60, 12), tilt: new Spring(0, 90, 11), lift: new Spring(0, 80, 12),
    };
    scene.add(g);
    /* a wet ring left on the counter */
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.055, 0.075, 24), new THREE.MeshPhysicalMaterial({
      color: 0x110804, roughness: 0.05, clearcoat: 1, transparent: true, opacity: 0.5,
    }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, BAR_TOP_Y + 0.002, GLASS_Z);
    scene.add(ring);
    return g;
  }
  const glass = { female: makeGlass(HOME_X.female), male: makeGlass(HOME_X.male) };

  /* ---------------- chip stacks ---------------- */
  const CHIP_Z = -0.30;
  const chipGeo = new THREE.CylinderGeometry(0.058, 0.058, 0.015, 22);
  const chipMats = [
    phys(0xc41e3a, { roughness: 0.32, clearcoat: 0.6 }),
    phys(0x14141c, { roughness: 0.34, clearcoat: 0.6 }),
    phys(0xe8b84a, { roughness: 0.28, metalness: 0.3, clearcoat: 0.7 }),
  ];
  function makeChips(x) {
    const g = new THREE.Group();
    g.position.set(x, BAR_TOP_Y, CHIP_Z);
    g.userData = { drops: [] };
    scene.add(g);
    return g;
  }
  const chips = { female: makeChips(HOME_X.female * 0.55), male: makeChips(HOME_X.male * 0.55) };

  function setChips(sex, credits) {
    const group = chips[sex];
    if (!group) return;
    const want = clamp(Math.round((credits || 0) / 7), 1, 18);
    while (group.children.length < want) {
      const c = new THREE.Mesh(chipGeo, chipMats[group.children.length % 3]);
      c.castShadow = true;
      c.userData.drop = 0.35;                        // drops in rather than popping
      group.add(c);
    }
    while (group.children.length > want) group.remove(group.children[group.children.length - 1]);
    group.children.forEach((c, i) => {
      const col = Math.floor(i / 9);
      const row = i % 9;
      c.userData.restY = 0.0085 + row * 0.0162;
      c.userData.restX = col * 0.135;
      c.position.x = c.userData.restX + Math.sin(i * 2.3) * 0.004;
      c.position.z = Math.cos(i * 1.7) * 0.004;
      c.rotation.y = i * 0.7;
    });
  }

  /* one chip in flight, for thefts and loans */
  const flyingChip = new THREE.Mesh(chipGeo, chipMats[2]);
  flyingChip.visible = false;
  flyingChip.castShadow = true;
  scene.add(flyingChip);
  const chipFlight = { t: 1, from: new THREE.Vector3(), to: new THREE.Vector3(), spin: 0 };

  /* The barman's rag. A fly stood on the counter is just a fly stood on the
     counter; a fly stood on the counter shoving a grey cloth around is
     working. It parks under the front legs and is hidden the rest of the
     time. */
  const rag = new THREE.Mesh(new THREE.PlaneGeometry(0.34, 0.26, 6, 5), std(0x8c9098, {
    roughness: 0.95, metalness: 0.0, envMapIntensity: 0.2, side: THREE.DoubleSide,
    transparent: true, opacity: 0,
  }));
  {
    /* rumple it once at build time so it never reads as a sheet of paper */
    const pos = rag.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) pos.setZ(i, rnd(-0.012, 0.012));
    rag.geometry.computeVertexNormals();
  }
  rag.rotation.x = -Math.PI / 2;
  rag.position.set(0, BAR_TOP_Y + 0.004, -0.4);
  rag.visible = false;
  rag.userData = { on: 0, sex: "male" };
  scene.add(rag);

  /* ---------------- barman: a silhouette, mostly ---------------- */
  const barman = new THREE.Group();
  const shadowMat = std(0x0e0b10, { roughness: 0.9, envMapIntensity: 0.15 });
  const bTorso = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.52, 8, 16), shadowMat);
  bTorso.position.y = 1.52;
  const bApron = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.42, 0.05), std(0xbdb29a, { roughness: 0.85, envMapIntensity: 0.25 }));
  bApron.position.set(0, 1.4, 0.18);
  const bHead = new THREE.Mesh(new THREE.SphereGeometry(0.14, 18, 14), shadowMat);
  bHead.position.y = 1.98;
  const bArm = new THREE.Group();
  const bSleeve = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.3, 6, 10), shadowMat);
  bSleeve.position.set(0, -0.17, 0);
  bArm.add(bSleeve);
  bArm.position.set(0.2, 1.68, 0.06);
  bArm.rotation.z = 0.6;
  const bTowel = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.025, 0.11), std(0x9a8a66, { roughness: 0.9 }));
  bTowel.position.set(0, -0.36, 0.04);
  bArm.add(bTowel);
  barman.add(bTorso, bApron, bHead, bArm);
  barman.position.set(0.55, 0, -1.62);
  barman.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  barman.userData = { arm: bArm, wipe: 0 };
  scene.add(barman);

  /* ---------------- particles ---------------- */
  const coins = [];
  const coinGeo = new THREE.CylinderGeometry(0.042, 0.042, 0.007, 16);
  const coinMat = new THREE.MeshStandardMaterial({
    color: 0xffd24a, metalness: 0.95, roughness: 0.16,
    emissive: 0x6a4400, emissiveIntensity: 0.6, envMapIntensity: 2.0,
  });
  function burstCoins(origin, n, jackpot) {
    const spread = jackpot ? 1.9 : 1.05;
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(coinGeo, coinMat);
      m.position.copy(origin).add(new THREE.Vector3(rnd(-0.06, 0.06), 0, rnd(-0.04, 0.04)));
      m.rotation.set(rnd(0, 3), rnd(0, 3), 0);
      m.castShadow = true;
      m.userData.v = new THREE.Vector3(rnd(-spread, spread), rnd(1.9, 3.4), rnd(0.5, 1.5));
      m.userData.w = new THREE.Vector3(rnd(-14, 14), rnd(-14, 14), rnd(-8, 8));
      m.userData.life = rnd(1.9, 3.0);
      scene.add(m);
      coins.push(m);
    }
  }

  const drops = [];
  const dropGeo = new THREE.SphereGeometry(0.014, 8, 6);
  const dropMat = new THREE.MeshPhysicalMaterial({
    color: 0xd8600f, roughness: 0.05, transmission: 0.6, thickness: 0.02,
    transparent: true, opacity: 0.9, emissive: 0x4a1800, emissiveIntensity: 0.6,
  });
  function splash(origin, n) {
    for (let i = 0; i < n; i++) {
      const m = new THREE.Mesh(dropGeo, dropMat.clone());
      m.position.copy(origin);
      m.scale.setScalar(rnd(0.5, 1.4));
      m.userData.v = new THREE.Vector3(rnd(-0.35, 0.35), rnd(0.35, 0.85), rnd(-0.1, 0.35));
      m.userData.life = rnd(0.45, 0.8);
      scene.add(m);
      drops.push(m);
    }
  }

  /* jackpot sparks, additive points */
  const SPARK_N = 220;
  const sparkPos = new Float32Array(SPARK_N * 3);
  const sparkVel = new Float32Array(SPARK_N * 3);
  const sparkLife = new Float32Array(SPARK_N);
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute("position", new THREE.BufferAttribute(sparkPos, 3));
  const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({
    map: sparkTex(), size: 0.07, transparent: true, opacity: 0.95, depthWrite: false,
    blending: THREE.AdditiveBlending, sizeAttenuation: true, toneMapped: false,
  }));
  sparks.frustumCulled = false;
  scene.add(sparks);
  let sparkHead = 0;
  function emitSparks(origin, n, power) {
    for (let i = 0; i < n; i++) {
      const k = sparkHead = (sparkHead + 1) % SPARK_N;
      sparkPos[k * 3] = origin.x; sparkPos[k * 3 + 1] = origin.y; sparkPos[k * 3 + 2] = origin.z;
      sparkVel[k * 3] = rnd(-1, 1) * power;
      sparkVel[k * 3 + 1] = rnd(0.6, 2.2) * power;
      sparkVel[k * 3 + 2] = rnd(-1, 1) * power;
      sparkLife[k] = rnd(0.6, 1.4);
    }
  }
  for (let i = 0; i < SPARK_N; i++) { sparkPos[i * 3 + 1] = -99; sparkLife[i] = 0; }

  /* dust motes drifting through the lamp cone */
  const DUST_N = 260;
  const dustPos = new Float32Array(DUST_N * 3);
  const dustVel = new Float32Array(DUST_N * 3);
  for (let i = 0; i < DUST_N; i++) {
    dustPos[i * 3] = rnd(-2.6, 2.6);
    dustPos[i * 3 + 1] = rnd(0.25, 2.9);
    dustPos[i * 3 + 2] = rnd(-1.9, 1.9);
    dustVel[i * 3] = rnd(-0.02, 0.02);
    dustVel[i * 3 + 1] = rnd(0.005, 0.035);
    dustVel[i * 3 + 2] = rnd(-0.015, 0.015);
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({
    map: sparkTex(), color: 0xffd9ae, size: 0.022, transparent: true, opacity: 0.35,
    depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
  }));
  dust.frustumCulled = false;
  scene.add(dust);

  /* ---------------- the actors ---------------- */
  const flies = {
    female: makeFly("female", scene, HOME_X.female, STOOL_Z, BODY_Y),
    male: makeFly("male", scene, HOME_X.male, STOOL_Z, BODY_Y),
  };

  const slotLook = new THREE.Vector3(0, BAR_TOP_Y + 0.6, SLOT_Z + 0.2);
  const barmanLook = new THREE.Vector3(0.55, 1.95, -1.5);
  const _chipLook = { female: new THREE.Vector3(), male: new THREE.Vector3() };

  function ctxFor(sex, st) {
    const b = (st[sex] && st[sex].brain) || {};
    const other = sex === "male" ? "female" : "male";
    _chipLook[other].copy(chips[other].position).add(new THREE.Vector3(0, 0.08, 0));
    return {
      instability: clamp(Number(b.cx_instability || 0), 0, 1),
      lean: clamp(Number(b.cx_lean || 0), -1, 1),
      heading: clamp(Number(b.epg_heading || 0), -1, 1),
      mn9: Number(b.mn9_hz || 0),
      da: clamp(Number(b.da || 0), 0, 2),
      oa: clamp(Number(b.oa || 0), 0, 2),
      rival: flies[other].head.getWorldPosition(new THREE.Vector3()),
      glass: glass[sex].position,
      slot: slotLook,
      chips: _chipLook[other],
      barman: barmanLook,
      cam: camera.position,
    };
  }

  /* ---------------- post-processing ---------------- */
  let composer = null, filmPass = null, bloomPass = null;
  try {
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
    bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.42, 0.48, 0.92);
    composer.addPass(bloomPass);
    filmPass = new ShaderPass(FilmShader);
    composer.addPass(filmPass);
    composer.addPass(new OutputPass());
  } catch (e) {
    composer = null;                                  // plain forward render still looks fine
  }

  /* ---------------- camera direction ---------------- */
  const camGoal = camHome.clone();
  const lookGoal = lookHome.clone();
  const shakeNow = new THREE.Vector3();
  let fovGoal = 36;
  let shake = 0;
  let flash = 0;
  let focusSex = "female";

  let shotKey = "";
  let shotT = 0;

  function frameShot(dt) {
    const rig = flies[focusSex] || flies.female;
    const idle = (p) => p === "idle" || p === "wait";
    const bothIdle = idle(flies.female.pose) && idle(flies.male.pose);
    const key = bothIdle ? "wide" : focusSex + ":" + rig.pose;
    if (key !== shotKey) { shotKey = key; shotT = 0; }
    shotT += dt;

    const shot = SHOTS[bothIdle ? "idle" : rig.pose] || SHOTS.idle;
    const s = rig.home.x > 0 ? 1 : -1;
    /* a very slight push in over the beat, so a held shot is never a photo */
    const dolly = 1 - 0.05 * smooth(shotT / 2.4);
    camGoal.set(shot.pos[0] * s, shot.pos[1], shot.pos[2] * dolly);
    const bias = shot.bias ?? BIAS;
    lookGoal.set(shot.look[0] + (bothIdle ? 0 : rig.root.position.x * bias), shot.look[1], shot.look[2]);
    fovGoal = shot.fov;
    /* hands off while the viewer is driving the camera themselves */
    if (performance.now() - grabbedAt < 7000) return;
    /* move fast for the first fifth of a second after a cut, then settle */
    const rate = shotT < 0.2 ? 14 : 3.2;
    camera.position.lerp(camGoal, 1 - Math.exp(-rate * dt));
    controls.target.lerp(lookGoal, 1 - Math.exp(-(rate + 1.5) * dt));
    camera.fov += (fovGoal - camera.fov) * (1 - Math.exp(-4 * dt));
    camera.updateProjectionMatrix();
  }

  /* ---------------- events from the game ---------------- */
  function notePose(sex, p) {
    const rig = flies[sex];
    if (!rig || !p) return;
    /* The server names the down state outright ("fall" to topple, "down" to
       lie there), so nothing here has to second-guess it from `fallen`. That
       guesswork used to fight triggerFx and restart the topple every beat. */
    setPose(rig, p.pose || "idle", getHoldMs ? getHoldMs() : 3000);
  }

  function triggerFx(fx) {
    if (!fx) return;
    const sex = fx.sex === "male" ? "male" : "female";
    const other = sex === "male" ? "female" : "male";
    const rig = flies[sex];
    /* The impacts below land mid-beat, not on the cut, because that is where
       the pose puts them. Delays are the pose's own timing in milliseconds:
       hold_ms, times the 0.92 the rig trims off it, times the phase. */
    const beat = (fx.hold_ms || 3600) * 0.92;
    const kind = fx.kind || "";
    focusSex = sex;
    grabbedAt = Math.min(grabbedAt, performance.now() - 7001);   // let the director take over again

    if (kind === "spin" || kind === "win" || kind === "lose" || fx.won !== undefined) {
      const ud = slot.userData;
      ud.spinT = 2.1;
      ud.won = !!fx.won;
      ud.jackpot = !!fx.jackpot;
      ud.speeds = [rnd(22, 30), rnd(26, 34), rnd(18, 27)];
      ud.stopAt = [0.62, 1.05, 1.5];
      ud.leverSpring.target = 1;
      setTimeout(() => { ud.leverSpring.target = 0; }, 260);
    }
    if (fx.won) {
      const origin = new THREE.Vector3(0, BAR_TOP_Y + 0.25, SLOT_Z + 0.3);
      burstCoins(origin, fx.jackpot ? 38 : 18, !!fx.jackpot);
      emitSparks(origin, fx.jackpot ? 150 : 60, fx.jackpot ? 2.2 : 1.2);
      slotGlow.intensity = fx.jackpot ? 8 : 4;
      shake = fx.jackpot ? 0.055 : 0.022;
      flash = fx.jackpot ? 0.22 : 0.07;
    }
    if (kind === "shot" || kind === "drink" || fx.free_drink) {
      const g = glass[sex];
      g.userData.sip = 1.0;
      g.userData.fill.target = Math.max(0.12, g.userData.fill.target - 0.3);
      splash(new THREE.Vector3(g.position.x, BAR_TOP_Y + 0.14, GLASS_Z + 0.03), 9);
    }
    /* A chip travels to the actor. Where it comes from is the whole story:
       off the rival's stack when stolen, out of the barman's shadow when
       earned or borrowed, and up off the boards when found. */
    const paid = kind === "borrow" || kind === "work";
    if (kind === "steal" || fx.take || paid || fx.found) {
      const fromKey = paid || fx.found ? null : (fx.from === "male" ? "male" : fx.from === "female" ? "female" : other);
      if (fx.found && !fx.take) {
        chipFlight.from.set(flies[sex].home.x, 0.1, flies[sex].home.z + 0.6);
      } else {
        chipFlight.from.copy(fromKey ? chips[fromKey].position : barmanLook).add(new THREE.Vector3(0, fromKey ? 0.1 : -0.35, 0.05));
      }
      chipFlight.to.copy(chips[sex].position).add(new THREE.Vector3(0, 0.12, 0.02));
      chipFlight.t = 0;
      chipFlight.spin = rnd(10, 18);
      flyingChip.visible = true;
      flyingChip.position.copy(chipFlight.from);
    }
    if (kind === "borrow" || kind === "work") barman.userData.wipe = 1.5;
    if (kind === "work") { rag.userData.on = beat / 1000; rag.userData.sex = sex; }
    if (kind === "fall") { shake = 0.04; flash = 0.04; }
    if (kind === "shove") {
      setTimeout(() => {
        shake = fx.toppled ? 0.05 : 0.03;
        const h = flies[other].home;
        emitSparks(new THREE.Vector3(h.x, h.y + 0.1, h.z), fx.toppled ? 40 : 24, 0.8);
      }, beat * 0.5);
    }
    if (kind === "lamp") {
      /* the bulb takes the hit: it swings, the room dims for a moment */
      setTimeout(() => {
        lamp.userData.knock = 1;
        lampLight.intensity = 1.0;
        shake = 0.026;
        flash = 0.05;
      }, beat * 0.45);
    }
    if (kind === "toast") {
      ["female", "male"].forEach((k) => {
        const g = glass[k];
        g.userData.sip = 1.0;
        g.userData.fill.target = Math.max(0.12, g.userData.fill.target - 0.3);
      });
      setTimeout(() => {
        emitSparks(new THREE.Vector3(0, BAR_TOP_Y + 0.3, GLASS_Z + 0.1), 34, 0.8);
        flash = 0.05;
      }, beat * 0.41);
    }
    if (rig) {
      const pose = kind === "shot" ? "drink" : (fx.won ? "win" : kind);
      if (pose) setPose(rig, pose, getHoldMs ? getHoldMs() : 3000);
    }
  }

  /* ---------------- resize ---------------- */
  function resize() {
    const w = Math.max(1, canvas.clientWidth);
    const h = Math.max(1, canvas.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (composer) composer.setSize(w, h);
    if (bloomPass) bloomPass.setSize(w, h);
  }
  addEventListener("resize", resize);
  resize();

  /* ---------------- loop ---------------- */
  const clock = new THREE.Clock();
  const _tmp = new THREE.Vector3();

  function tick() {
    requestAnimationFrame(tick);
    const t = clock.elapsedTime;
    /* Real elapsed time, only clamped enough to survive a tab switch. The
       springs sub-step internally, so a slow machine looks choppy but the
       beats still take as long as the caption says they do. */
    const dt = Math.min(0.2, clock.getDelta());
    const st = getState() || {};

    /* undo last frame's shake so OrbitControls never accumulates it */
    camera.position.sub(shakeNow);
    shakeNow.set(0, 0, 0);

    /* actors */
    ["female", "male"].forEach((sex) => {
      const rig = flies[sex];
      const ctx = ctxFor(sex, st);
      updateFly(rig, ctx, dt, t);
      const tl = tintLight[sex];
      tl.position.copy(rig.root.position).add(_tmp.set(rig.home.x > 0 ? 0.32 : -0.32, 0.22, -0.2));
      tl.intensity = 0.35 + (sex === focusSex ? 0.45 : 0) + clamp(ctx.da, 0, 1) * 0.3;
    });

    /* the follow spot */
    const fr = flies[focusSex];
    actorLight.target.position.lerp(fr.root.position, 1 - Math.exp(-6 * dt));
    /* The spot rides down with the actor. Parked at the ceiling it is nearly
       three metres from a fly on the floor, which with a quadratic falloff
       means a scrounging fly is a dark smudge; and it now has to stay under
       the ceiling plane anyway. */
    actorLight.position.set(
      lerp(actorLight.position.x, fr.root.position.x * 0.6, 1 - Math.exp(-4 * dt)),
      lerp(actorLight.position.y, clamp(fr.root.position.y + 1.4, 1.5, 2.8), 1 - Math.exp(-4 * dt)),
      lerp(actorLight.position.z, fr.root.position.z + 0.9, 1 - Math.exp(-4 * dt))
    );
    const acting = fr.pose !== "idle" && fr.pose !== "wait";
    actorLight.intensity += ((acting ? 6.5 : 1.8) - actorLight.intensity) * (1 - Math.exp(-4 * dt));

    /* slot machine */
    const ud = slot.userData;
    ud.lever.rotation.x = ud.leverSpring.step(dt) * 1.15;
    if (ud.spinT > 0) {
      const elapsed = 2.1 - ud.spinT;
      ud.spinT -= dt;
      ud.reels.forEach((r, i) => {
        if (elapsed < ud.stopAt[i] + 0.6) {
          r.rotation.x += ud.speeds[i] * dt * clamp(1 - (elapsed - ud.stopAt[i]) / 0.6, 0.06, 1);
        } else {
          /* snap to the nearest symbol; winners land on a shared face */
          const step = (Math.PI * 2) / 8;
          const want = ud.won ? 0 : Math.round(r.rotation.x / step + i * 0.34) * step;
          const snap = ud.won ? Math.round(r.rotation.x / step) * step : want;
          r.rotation.x += (snap - r.rotation.x) * (1 - Math.exp(-14 * dt));
        }
      });
      if (ud.spinT <= 0 && ud.won) { flash = Math.max(flash, 0.06); }
    }
    const hot = ud.spinT > 0 || slotGlow.intensity > 1;
    ud.lamps.forEach((b, i) => {
      b.material.emissiveIntensity = hot ? 1.4 + Math.sin(t * 18 + i * 0.9) * 1.2 : 0.55 + Math.sin(t * 1.4 + i) * 0.15;
    });
    ud.marquee.material.emissiveIntensity = hot ? 2.2 + Math.sin(t * 22) * 1.0 : 1.2;
    slotGlow.intensity *= Math.exp(-2.2 * dt);

    /* room ambience */
    neonL.intensity = 2.4 + Math.sin(t * 2.3) * 0.45 + (Math.random() < 0.006 ? -1.6 : 0);
    neonR.intensity = 1.25 + Math.sin(t * 1.7 + 2) * 0.25;
    lampLight.intensity += (4.2 - lampLight.intensity) * (1 - Math.exp(-2 * dt));
    /* the pendant's idle sway, plus a decaying swing after somebody hits it */
    lamp.userData.knock = Math.max(0, lamp.userData.knock - dt * 0.45);
    const kn = lamp.userData.knock;
    lamp.rotation.z = Math.sin(t * 0.55) * 0.02 + Math.sin(t * 7.5) * kn * kn * 0.3;
    lamp.rotation.x = Math.sin(t * 6.1 + 1) * kn * kn * 0.2;
    fan.rotation.y += dt * 0.9;

    /* the rag tracks just ahead of whoever is pushing it */
    if (rag.userData.on > 0) {
      rag.userData.on -= dt;
      const r = flies[rag.userData.sex];
      _tmp.set(0, 0, 0.13).applyQuaternion(r.root.quaternion).add(r.root.position);
      rag.position.x += (_tmp.x - rag.position.x) * (1 - Math.exp(-16 * dt));
      rag.position.z += (_tmp.z - rag.position.z) * (1 - Math.exp(-16 * dt));
      rag.position.y = BAR_TOP_Y + 0.005;
      rag.rotation.z = r.root.rotation.y;
      rag.visible = true;
      /* fade in over the climb up and out again as the fly drops off */
      rag.material.opacity = clamp(Math.min(rag.userData.on, 0.6) * 1.6, 0, 0.95);
    } else if (rag.visible) {
      rag.material.opacity = Math.max(0, rag.material.opacity - dt * 2);
      if (rag.material.opacity <= 0) rag.visible = false;
    }

    /* barman */
    const bw = barman.userData;
    if (bw.wipe > 0) {
      bw.wipe -= dt;
      bw.arm.rotation.z = 0.6 + Math.sin(t * 13) * 0.35;
      barman.rotation.y = Math.sin(t * 6) * 0.18;
    } else {
      bw.arm.rotation.z = 0.6 + Math.sin(t * 1.1) * 0.12;
      barman.rotation.y = Math.sin(t * 0.33) * 0.12;
    }

    /* glasses: lift, tilt, drain, settle */
    ["female", "male"].forEach((sex) => {
      const g = glass[sex];
      const u = g.userData;
      if (u.sip > 0) {
        u.sip -= dt * 0.75;
        const k = Math.sin(clamp(1 - u.sip, 0, 1) * Math.PI);
        u.lift.target = k * 0.22;
        u.tilt.target = -k * 1.0;
      } else {
        u.lift.target = 0;
        u.tilt.target = 0;
        u.fill.target = Math.min(1, u.fill.target + dt * 0.12);   // the barman tops it up
      }
      g.position.set(u.home.x, u.home.y + u.lift.step(dt), u.home.z + u.lift.v * 0.9);
      g.rotation.x = u.tilt.step(dt);
      const f = clamp(u.fill.step(dt), 0.06, 1);
      u.liquid.scale.y = f;
      u.liquid.position.y = 0.012 + f * 0.05;
    });

    /* chips settling into the stack */
    ["female", "male"].forEach((sex) => {
      chips[sex].children.forEach((c) => {
        const d = c.userData;
        if (d.drop > 0) {
          d.drop -= dt;
          c.position.y = d.restY + Math.max(0, d.drop) * 1.3;
          c.rotation.x = Math.max(0, d.drop) * 1.2;
        } else {
          c.position.y += (d.restY - c.position.y) * (1 - Math.exp(-18 * dt));
          c.rotation.x *= Math.exp(-10 * dt);
        }
      });
    });

    /* chip in flight */
    if (chipFlight.t < 1) {
      chipFlight.t = Math.min(1, chipFlight.t + dt * 1.25);
      const k = smooth(chipFlight.t);
      flyingChip.position.lerpVectors(chipFlight.from, chipFlight.to, k);
      flyingChip.position.y += Math.sin(k * Math.PI) * 0.34;
      flyingChip.rotation.x = chipFlight.t * chipFlight.spin;
      flyingChip.rotation.z = chipFlight.t * chipFlight.spin * 0.6;
      if (chipFlight.t >= 1) flyingChip.visible = false;
    }

    /* coins */
    for (let i = coins.length - 1; i >= 0; i--) {
      const c = coins[i];
      const d = c.userData;
      d.v.y -= 8.6 * dt;
      c.position.addScaledVector(d.v, dt);
      c.rotation.x += d.w.x * dt; c.rotation.y += d.w.y * dt; c.rotation.z += d.w.z * dt;
      const ground = c.position.z > BAR_FRONT_Z ? 0.02 : BAR_TOP_Y + 0.004;
      if (c.position.y < ground) {
        c.position.y = ground;
        d.v.y *= -0.42;
        d.v.x *= 0.62; d.v.z *= 0.62;
        d.w.multiplyScalar(0.55);
        if (Math.abs(d.v.y) < 0.35) d.v.y = 0;
      }
      d.life -= dt;
      if (d.life < 0.4) c.scale.setScalar(Math.max(0.01, d.life / 0.4));
      if (d.life <= 0) { scene.remove(c); coins.splice(i, 1); }
    }

    /* droplets */
    for (let i = drops.length - 1; i >= 0; i--) {
      const c = drops[i];
      const d = c.userData;
      d.v.y -= 9.2 * dt;
      c.position.addScaledVector(d.v, dt);
      d.life -= dt;
      c.material.opacity = clamp(d.life * 2.2, 0, 0.9);
      if (d.life <= 0) { scene.remove(c); drops.splice(i, 1); }
    }

    /* sparks */
    let sparkLive = false;
    for (let i = 0; i < SPARK_N; i++) {
      if (sparkLife[i] <= 0) continue;
      sparkLive = true;
      sparkLife[i] -= dt;
      sparkVel[i * 3 + 1] -= 3.4 * dt;
      sparkPos[i * 3] += sparkVel[i * 3] * dt;
      sparkPos[i * 3 + 1] += sparkVel[i * 3 + 1] * dt;
      sparkPos[i * 3 + 2] += sparkVel[i * 3 + 2] * dt;
      if (sparkLife[i] <= 0) sparkPos[i * 3 + 1] = -99;
    }
    if (sparkLive) sparkGeo.attributes.position.needsUpdate = true;

    /* dust */
    for (let i = 0; i < DUST_N; i++) {
      dustPos[i * 3] += (dustVel[i * 3] + Math.sin(t * 0.4 + i) * 0.01) * dt;
      dustPos[i * 3 + 1] += dustVel[i * 3 + 1] * dt;
      dustPos[i * 3 + 2] += dustVel[i * 3 + 2] * dt;
      if (dustPos[i * 3 + 1] > 3.0) { dustPos[i * 3 + 1] = 0.2; dustPos[i * 3] = rnd(-2.6, 2.6); }
    }
    dustGeo.attributes.position.needsUpdate = true;

    /* camera */
    frameShot(dt);
    controls.update();
    if (shake > 0.0005) {
      shake *= Math.exp(-5.5 * dt);
      shakeNow.set(rnd(-1, 1), rnd(-1, 1), rnd(-1, 1)).multiplyScalar(shake);
      camera.position.add(shakeNow);
    }

    /* render */
    if (composer && filmPass) {
      flash *= Math.exp(-6 * dt);
      filmPass.uniforms.time.value = t;
      filmPass.uniforms.flash.value = flash;
      composer.render();
    } else {
      renderer.render(scene, camera);
    }
  }
  tick();

  const api = {
    debug: {
      scene, camera, controls, flies, slot, glass, chips,
      get focus() { return focusSex; },
      holdCamera() { grabbedAt = performance.now() + 1e7; },
      freeCamera() { grabbedAt = -1e9; },
    },
    triggerFx,
    notePose,
    setChips,
    focus(sex) { if (flies[sex]) focusSex = sex; },
    resetRigs() {
      ["female", "male"].forEach((sex) => {
        const rig = flies[sex];
        rig.place = "stool";        // before setPose, which reads it
        setPose(rig, "idle", 2800);
        rig.root.position.copy(rig.home);
        rig.s.px.set(rig.home.x); rig.s.py.set(rig.home.y); rig.s.pz.set(rig.home.z);
        rig.s.rx.set(0.06); rig.s.ry.set(rig.baseYaw); rig.s.rz.set(0);
        rig.legs.forEach((leg) => {
          leg.foot.set(rig.home.x + leg.homeOffset.x, SEAT_Y, rig.home.z + leg.homeOffset.z);
          leg.stepT = 1;
        });
      });
      coins.splice(0).forEach((c) => scene.remove(c));
      drops.splice(0).forEach((c) => scene.remove(c));
      flyingChip.visible = false;
      chipFlight.t = 1;
    },
  };
  if (typeof window !== "undefined") window.__stage = api;
  return api;
}
