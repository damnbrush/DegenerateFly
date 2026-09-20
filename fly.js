/* ------------------------------------------------------------------ *
 * fly.js — the actor rig.
 *
 * Two things here are worth knowing before reading:
 *
 *  1. Legs are solved with two-bone IK against feet that live in WORLD
 *     space. Feet are planted and only step in an alternating tripod, so
 *     the body can lean, sway and squash while the feet stay on the
 *     stool. That is what makes it read as a creature instead of a prop.
 *
 *  2. Every soft channel (head aim, abdomen follow-through, hat, wings,
 *     proboscis) is a spring, so poses overshoot and settle rather than
 *     snapping. Actions only set spring targets; they never set values.
 * ------------------------------------------------------------------ */
import * as THREE from "three";

export const L1 = 0.155;   // femur
export const L2 = 0.150;   // tibia

/* Rest pose of the male trucker cap, in head space. Eyes top out around
   y 0.15, so anything lower than that sits inside them. */
const MALE_HAT = { y: 0.188, z: -0.018, rx: -0.16 };

/** Body height when standing on the counter rather than the stool. */
const BAR_STAND_Y = 1.275;

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
function pulse(u, a, b) { if (u < a || u > b) return 0; return Math.sin(((u - a) / (b - a)) * Math.PI); }
function ramp(u, a, b) { return clamp((u - a) / Math.max(1e-4, b - a), 0, 1); }

export class Spring {
  constructor(v = 0, k = 160, d = 20) { this.v = v; this.vel = 0; this.target = v; this.k = k; this.d = d; }
  /** Sub-stepped, so a stiff spring stays stable no matter the framerate
      and a slow machine plays the animation slow rather than wrong. */
  step(dt) {
    let rem = Math.min(dt, 0.25);
    while (rem > 1e-5) {
      const h = Math.min(rem, 1 / 120);
      this.vel += (this.k * (this.target - this.v) - this.d * this.vel) * h;
      this.v += this.vel * h;
      rem -= h;
    }
    return this.v;
  }
  kick(a) { this.vel += a; }
  set(v) { this.v = this.target = v; this.vel = 0; }
}

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

function ommatidiaTex(hot, mid, seam) {
  return canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = mid; g.fillRect(0, 0, w, h);
    const r = 12, dx = r * Math.sqrt(3), dy = r * 1.5;
    for (let row = -1; row * dy < h + dy; row++) {
      for (let col = -1; col * dx < w + dx; col++) {
        const x = col * dx + (row & 1 ? dx / 2 : 0);
        const y = row * dy;
        g.beginPath();
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 180) * (60 * i - 30);
          g.lineTo(x + Math.cos(a) * r * 0.97, y + Math.sin(a) * r * 0.97);
        }
        g.closePath();
        const grd = g.createRadialGradient(x - r * 0.35, y - r * 0.35, 0, x, y, r);
        grd.addColorStop(0, hot); grd.addColorStop(0.6, mid); grd.addColorStop(1, seam);
        g.fillStyle = grd; g.fill();
        g.strokeStyle = seam; g.lineWidth = 1.2; g.stroke();
      }
    }
  });
}

function ommatidiaBump() {
  return canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = "#777777"; g.fillRect(0, 0, w, h);
    const r = 12, dx = r * Math.sqrt(3), dy = r * 1.5;
    for (let row = -1; row * dy < h + dy; row++) {
      for (let col = -1; col * dx < w + dx; col++) {
        const x = col * dx + (row & 1 ? dx / 2 : 0), y = row * dy;
        const grd = g.createRadialGradient(x, y, 0, x, y, r);
        grd.addColorStop(0, "#ffffff"); grd.addColorStop(0.75, "#6a6a6a"); grd.addColorStop(1, "#141414");
        g.fillStyle = grd;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
    }
  }, false);
}

function wingTex() {
  return canvasTex(512, 256, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    const grd = g.createLinearGradient(0, 0, w, 0);
    grd.addColorStop(0, "rgba(216,234,255,0.62)");
    grd.addColorStop(0.55, "rgba(198,220,255,0.34)");
    grd.addColorStop(1, "rgba(238,216,255,0.14)");
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
    g.lineCap = "round";
    const veins = [
      [0.02, 0.52, 0.45, 0.30, 0.98, 0.26],
      [0.02, 0.54, 0.42, 0.46, 0.98, 0.44],
      [0.02, 0.56, 0.40, 0.62, 0.96, 0.62],
      [0.02, 0.58, 0.36, 0.78, 0.88, 0.80],
      [0.03, 0.60, 0.26, 0.90, 0.62, 0.93],
    ];
    veins.forEach((v, i) => {
      g.strokeStyle = "rgba(126,148,178," + (0.52 - i * 0.05) + ")";
      g.lineWidth = 3.4 - i * 0.45;
      g.beginPath();
      g.moveTo(v[0] * w, v[1] * h);
      g.quadraticCurveTo(v[2] * w, v[3] * h, v[4] * w, v[5] * h);
      g.stroke();
    });
    g.strokeStyle = "rgba(126,148,178,0.28)"; g.lineWidth = 1.6;
    for (let i = 0; i < 5; i++) {
      const x = (0.35 + i * 0.13) * w;
      g.beginPath(); g.moveTo(x, 0.3 * h); g.lineTo(x - 0.02 * w, 0.72 * h); g.stroke();
    }
    g.strokeStyle = "rgba(154,174,204,0.55)"; g.lineWidth = 4;
    g.beginPath();
    g.moveTo(0.02 * w, 0.5 * h);
    g.quadraticCurveTo(0.5 * w, 0.16 * h, 0.99 * w, 0.28 * h);
    g.stroke();
  });
}

function flagTex() {
  return canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = "#a81a22"; g.fillRect(0, 0, w, h);
    const saltire = (color, width) => {
      g.strokeStyle = color; g.lineWidth = width; g.lineCap = "butt";
      g.beginPath(); g.moveTo(0, 0); g.lineTo(w, h); g.stroke();
      g.beginPath(); g.moveTo(w, 0); g.lineTo(0, h); g.stroke();
    };
    saltire("#efe6d8", 54);
    saltire("#16306b", 38);
    const stars = [
      [0.5, 0.5], [0.18, 0.18], [0.34, 0.34], [0.66, 0.66], [0.82, 0.82],
      [0.82, 0.18], [0.66, 0.34], [0.34, 0.66], [0.18, 0.82],
      [0.5, 0.2], [0.5, 0.8], [0.2, 0.5], [0.8, 0.5],
    ];
    g.fillStyle = "#efe6d8";
    stars.forEach((s) => {
      const x = s[0] * w, y = s[1] * h, r = 7;
      g.beginPath();
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 5;
        const b = a + Math.PI / 5;
        g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
        g.lineTo(x + Math.cos(b) * r * 0.4, y + Math.sin(b) * r * 0.4);
      }
      g.closePath(); g.fill();
    });
    g.fillStyle = "rgba(0,0,0,0.16)";
    for (let i = 0; i < 500; i++) g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  });
}

export function blobTex() {
  return canvasTex(128, 128, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grd.addColorStop(0, "rgba(0,0,0,0.82)");
    grd.addColorStop(0.45, "rgba(0,0,0,0.36)");
    grd.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  }, false);
}

/* shared, built once */
let TEX = null;
function tex() {
  if (!TEX) {
    TEX = {
      eyeF: ommatidiaTex("#ff8fb4", "#d6264f", "#5e0a20"),
      eyeM: ommatidiaTex("#ff9a5c", "#c41a18", "#4a0606"),
      eyeBump: ommatidiaBump(),
      wing: wingTex(),
      flag: flagTex(),
      blob: blobTex(),
    };
  }
  return TEX;
}

/* ------------------------------------------------------------------ *
 * headgear
 * ------------------------------------------------------------------ */
export function makeBow() {
  const bow = new THREE.Group();
  /* Satin, but muted: a hot pink with a strong clearcoat sails past the
     bloom threshold under the neon and the bow turns into a white blob. */
  const satin = new THREE.MeshPhysicalMaterial({
    color: 0xd4457f, roughness: 0.45, metalness: 0.0,
    sheen: 0.8, sheenColor: new THREE.Color(0xffbcd8), sheenRoughness: 0.45,
    clearcoat: 0.28, clearcoatRoughness: 0.45, envMapIntensity: 0.3,
  });
  const satinKnot = satin.clone();
  satinKnot.color.setHex(0xa32f61);

  /* A bow loop is pinched to almost nothing at the knot and opens out wide.
     Leave the origin nearly horizontally or the pinch is lost and each loop
     reads as a round puck instead of a folded ribbon. */
  const loopShape = new THREE.Shape();
  loopShape.moveTo(0.004, 0.015);
  loopShape.bezierCurveTo(0.058, 0.098, 0.128, 0.108, 0.168, 0.053);
  loopShape.quadraticCurveTo(0.195, 0.010, 0.160, -0.038);
  loopShape.bezierCurveTo(0.122, -0.088, 0.050, -0.074, 0.004, -0.015);
  loopShape.quadraticCurveTo(-0.007, 0, 0.004, 0.015);
  const loopGeo = new THREE.ExtrudeGeometry(loopShape, {
    depth: 0.023, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.005,
    bevelSegments: 2, curveSegments: 20,
  });
  loopGeo.translate(0, 0, -0.012);
  const loop = (s) => {
    const m = new THREE.Mesh(loopGeo, satin);
    m.scale.set(s * 1.06, 0.82, 1);    // wider than tall, which reads cuter
    m.position.set(s * 0.014, 0.008, 0);
    m.rotation.y = -s * 0.34;          // splay them apart so it reads in 3D
    m.rotation.z = s * 0.16;
    m.rotation.x = s * 0.14;           // and a little twist, as ribbon does
    return m;
  };

  /* the knot: a little band cinched around the middle */
  const knot = new THREE.Mesh(new THREE.SphereGeometry(0.040, 14, 12), satinKnot);
  knot.scale.set(1.2, 1.0, 1.1);
  const cinch = new THREE.Mesh(new THREE.TorusGeometry(0.038, 0.014, 8, 20), satinKnot);
  cinch.rotation.y = Math.PI / 2;
  cinch.scale.set(1, 1.15, 1);

  /* ribbon tails, notched at the ends — the notch is what makes a ribbon
     read as a ribbon rather than a strap */
  const tailShape = new THREE.Shape();
  tailShape.moveTo(-0.026, 0.02);
  tailShape.lineTo(0.026, 0.02);
  tailShape.lineTo(0.040, -0.175);
  tailShape.lineTo(0.0, -0.122);
  tailShape.lineTo(-0.040, -0.175);
  tailShape.closePath();
  const tailGeo = new THREE.ExtrudeGeometry(tailShape, {
    depth: 0.011, bevelEnabled: true, bevelSize: 0.004, bevelThickness: 0.003, bevelSegments: 1,
  });
  /* The bow sits right on the crown of the head, so tails pointing straight
     down would vanish inside it. Splay them out past the head instead, then
     let them droop back over the shoulders. */
  const tails = new THREE.Group();
  tails.userData = { rest: -0.32 };
  tails.rotation.x = tails.userData.rest;
  tails.position.set(0, -0.014, -0.012);
  [-1, 1].forEach((s) => {
    const m = new THREE.Mesh(tailGeo, satin);
    m.position.set(s * 0.026, 0, s * 0.006);
    m.rotation.z = -s * 1.05;
    m.rotation.y = s * 0.26;
    tails.add(m);
  });

  bow.add(loop(-1), loop(1), knot, cinch, tails);
  bow.scale.setScalar(1.18);        // the eyes are huge; the bow has to compete
  bow.userData = { tails };
  return bow;
}

/** The bill of a real cap is a shaped shell, not a flat disc: it curls down
 *  at the sides and dips a little at the tip. So extrude a D-shape and then
 *  bend the vertices. Keep the bend gentle — overdo it and you get a canoe. */
function makeBill(mat) {
  const s = new THREE.Shape();
  /* a real visor: wide, long, rounded at the front. The old one was a
     fingernail on the eyes; this has to read as a brim from across the bar. */
  s.moveTo(-0.155, -0.028);
  s.bezierCurveTo(-0.188, 0.062, -0.170, 0.205, -0.064, 0.248);
  s.bezierCurveTo(-0.022, 0.262, 0.022, 0.262, 0.064, 0.248);
  s.bezierCurveTo(0.170, 0.205, 0.188, 0.062, 0.155, -0.028);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, {
    depth: 0.030, bevelEnabled: true, bevelSize: 0.008, bevelThickness: 0.007,
    bevelSegments: 2, curveSegments: 24,
  });
  g.rotateX(Math.PI / 2);        // lay it flat; the shape's +Y becomes forward
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = Math.max(0, p.getZ(i));
    p.setY(i, p.getY(i) - x * x * 0.95 - z * z * 0.24);
  }
  g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}

export function makeTruckerCap() {
  const cap = new THREE.Group();
  /* pale but not white: the follow spot blows a white foam panel out flat */
  const foam = new THREE.MeshStandardMaterial({ color: 0xb2ac9a, roughness: 0.93, envMapIntensity: 0.14 });
  const netting = new THREE.MeshStandardMaterial({ color: 0x232329, roughness: 0.94, envMapIntensity: 0.14 });
  const trim = new THREE.MeshStandardMaterial({ color: 0x15151a, roughness: 0.85, envMapIntensity: 0.12 });

  /* Two real panels rather than one shell: pale foam across the front,
     dark mesh around the back. In three's sphere phi = PI/2 faces +Z, so
     the front panel spans PI/2 +/- FRONT_HALF. */
  const FRONT_HALF = 1.26;
  /* Wider and taller than the skull, and than the compound eyes it used to
     sit inside of. A trucker cap on a fly has to be a hat, not a sticker. */
  const CROWN_R = 0.198, CROWN_Y = 0.92;
  const crownFront = new THREE.Mesh(
    new THREE.SphereGeometry(CROWN_R, 28, 16, Math.PI / 2 - FRONT_HALF, FRONT_HALF * 2, 0, Math.PI / 2), foam);
  const crownBack = new THREE.Mesh(
    new THREE.SphereGeometry(CROWN_R, 28, 16, Math.PI / 2 + FRONT_HALF, Math.PI * 2 - FRONT_HALF * 2, 0, Math.PI / 2), netting);
  crownFront.scale.set(1, CROWN_Y, 1);
  crownBack.scale.set(1, CROWN_Y, 1);

  /* A short side wall under the dome gives the cap real depth. Kept shallow
     on purpose: wrapping the eyes is what made the old one clip. */
  const WALL_H = 0.048;
  const wall = new THREE.Mesh(
    new THREE.CylinderGeometry(CROWN_R, CROWN_R * 0.94, WALL_H, 28, 1, true), netting);
  wall.position.y = -WALL_H / 2;
  const sweat = new THREE.Mesh(new THREE.TorusGeometry(CROWN_R * 0.95, 0.009, 6, 30), trim);
  sweat.rotation.x = Math.PI / 2;
  sweat.position.y = -WALL_H;

  const bill = makeBill(foam);
  bill.position.set(0, -0.010, 0.055);
  bill.rotation.x = -0.10;

  /* The flag, wrapped onto the front panel. A sphere segment would be easier
     but its UVs pinch toward the pole, which shears the flag into a trapezoid;
     so bend a rectangle onto the crown instead and keep the patch square. */
  const patch = (() => {
    const R = CROWN_R + 0.002, W = 0.255, H = 0.175, MID = 0.95;
    const g = new THREE.PlaneGeometry(W, H, 14, 10);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const phi = Math.PI / 2 + p.getX(i) / R;      // along the crown, front-centred
      const th = MID - p.getY(i) / R;               // down from the top of the crown
      p.setXYZ(i, -R * Math.cos(phi) * Math.sin(th), R * Math.cos(th), R * Math.sin(phi) * Math.sin(th));
    }
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
      map: tex().flag, roughness: 0.84, envMapIntensity: 0.14,
    }));
    m.scale.set(1, CROWN_Y, 1);
    return m;
  })();

  /* squatchee on top, and the snapback strap around the back */
  const button = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), netting);
  button.position.y = CROWN_R * CROWN_Y - 0.004;
  const strapGeo = new THREE.TorusGeometry(CROWN_R * 0.96, 0.010, 6, 22, 1.25);
  strapGeo.rotateZ(-Math.PI / 2 - 0.625);   // centre the arc on -Y ...
  strapGeo.rotateX(Math.PI / 2);            // ... which lays flat as -Z, the back
  strapGeo.translate(0, -0.016, 0);
  const strap = new THREE.Mesh(strapGeo, foam);
  const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.022, 0.014), trim);
  buckle.position.set(0, -0.016, -CROWN_R * 0.96);

  cap.add(crownFront, crownBack, wall, sweat, bill, patch, button, strap, buckle);
  cap.userData = { bill };
  return cap;
}

/* ------------------------------------------------------------------ *
 * one leg: coxa → [aim] → femur → knee → tibia → tarsus
 * ------------------------------------------------------------------ */
function buildLeg(parent, hipPos, side, idx, mat) {
  const hip = new THREE.Group();
  hip.position.copy(hipPos);
  parent.add(hip);

  const coxa = new THREE.Mesh(new THREE.SphereGeometry(0.026, 8, 6), mat);
  coxa.scale.set(1, 0.8, 1);
  hip.add(coxa);

  const aim = new THREE.Group();
  hip.add(aim);
  const femurG = new THREE.Group();
  aim.add(femurG);
  const femur = new THREE.Mesh(new THREE.CylinderGeometry(0.0175, 0.012, L1, 7), mat);
  femur.position.y = -L1 / 2;
  femurG.add(femur);
  /* a couple of bristles on the femur — reads at any distance */
  for (let i = 0; i < 3; i++) {
    const b = new THREE.Mesh(new THREE.ConeGeometry(0.0035, 0.032, 4), mat);
    b.position.set(0.012, -0.035 - i * 0.035, 0);
    b.rotation.z = -1.1;
    femurG.add(b);
  }
  const kneeG = new THREE.Group();
  kneeG.position.y = -L1;
  femurG.add(kneeG);
  const tibia = new THREE.Mesh(new THREE.CylinderGeometry(0.0115, 0.0075, L2, 6), mat);
  tibia.position.y = -L2 / 2;
  kneeG.add(tibia);

  const tarsusG = new THREE.Group();
  tarsusG.position.y = -L2;
  kneeG.add(tarsusG);
  const tarsus = new THREE.Mesh(new THREE.CylinderGeometry(0.0075, 0.004, 0.065, 5), mat);
  tarsus.position.y = -0.032;
  tarsusG.add(tarsus);
  const pad = new THREE.Mesh(new THREE.SphereGeometry(0.012, 7, 5), mat);
  pad.position.y = -0.064;
  pad.scale.set(1, 0.55, 1.3);
  tarsusG.add(pad);

  hip.traverse((o) => { if (o.isMesh) o.castShadow = true; });

  return {
    hip, aim, femurG, kneeG, tarsusG, side, idx,
    tripod: (idx === 0 || idx === 4 || idx === 2) ? 0 : 1,
    homeOffset: new THREE.Vector3(),
    foot: new THREE.Vector3(),
    stepFrom: new THREE.Vector3(),
    stepTo: new THREE.Vector3(),
    stepT: 1,
  };
}

const DOWN = new THREE.Vector3(0, -1, 0);
const _d = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _out = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _lampV = new THREE.Vector3();

/** Aim the limb at `targetLocal` (in the leg parent's space) and bend the
 *  knee outward-and-up the way an insect's does. */
function solveLeg(leg, targetLocal) {
  _d.copy(targetLocal).sub(leg.hip.position);
  let dist = _d.length();
  if (dist < 1e-5) { _d.copy(DOWN).multiplyScalar(0.1); dist = 0.1; }
  const reach = (L1 + L2) * 0.985;
  dist = clamp(dist, 0.07, reach);
  _dir.copy(_d).normalize();

  /* build the limb basis so that +X is the bend axis and the knee travels
     toward `_out` (outboard and slightly up) */
  _out.set(leg.side, 0.55, 0).normalize();
  _x.crossVectors(_dir, _out);
  if (_x.lengthSq() < 1e-8) _x.set(0, 0, 1);
  _x.normalize();
  _y.copy(_dir).negate();
  _z.crossVectors(_x, _y).normalize();
  _m.makeBasis(_x, _y, _z);
  leg.aim.quaternion.setFromRotationMatrix(_m);

  const cosHip = clamp((L1 * L1 + dist * dist - L2 * L2) / (2 * L1 * dist), -1, 1);
  const cosKnee = clamp((L1 * L1 + L2 * L2 - dist * dist) / (2 * L1 * L2), -1, 1);
  const a1 = Math.acos(cosHip);
  const knee = Math.acos(cosKnee);
  leg.femurG.rotation.x = a1;
  leg.kneeG.rotation.x = -(Math.PI - knee);
  /* let the tarsus flatten out toward the surface instead of spearing it */
  leg.tarsusG.rotation.x = lerp(leg.tarsusG.rotation.x, (Math.PI - knee) - a1 + 0.35, 0.3);
}

/* ------------------------------------------------------------------ *
 * the fly
 * ------------------------------------------------------------------ */
export function makeFly(sex, scene, homeX, homeZ, bodyY) {
  const T = tex();
  const female = sex === "female";

  /* Built facing local +Z. Seated facing the bar, but swivelled inward so
     each fly is angled at the other — it keeps them in three-quarter view
     from either side of the counter instead of dead-on from behind. */
  const baseYaw = Math.PI - (homeX > 0 ? 1 : -1) * 0.85;
  const root = new THREE.Group();
  root.position.set(homeX, bodyY, homeZ);
  root.rotation.y = baseYaw;
  scene.add(root);

  const body = new THREE.Group();      // squash/stretch lives here, legs do not
  root.add(body);

  /* Chitin is waxy, not metal. Keep metalness near zero and let a soft
     clearcoat do the shine, or the flies come out looking chrome-plated. */
  const chitin = new THREE.MeshPhysicalMaterial({
    color: female ? 0x6a5236 : 0x3c3d48,
    roughness: 0.42, metalness: 0.04,
    clearcoat: 0.45, clearcoatRoughness: 0.42,
    sheen: 0.5, sheenColor: new THREE.Color(female ? 0xffd9a0 : 0x9fb4ff),
    envMapIntensity: 0.55,
  });
  const dark = new THREE.MeshPhysicalMaterial({
    color: female ? 0x241a10 : 0x111118, roughness: 0.48, metalness: 0.03,
    clearcoat: 0.35, clearcoatRoughness: 0.5, envMapIntensity: 0.45,
  });
  const limb = new THREE.MeshStandardMaterial({ color: 0x18140f, roughness: 0.55, metalness: 0.15, envMapIntensity: 0.6 });

  /* thorax */
  const thorax = new THREE.Mesh(new THREE.SphereGeometry(0.2, 26, 20), chitin);
  thorax.scale.set(1.0, 0.92, 1.18);
  body.add(thorax);
  /* two dark longitudinal stripes, as on a real Drosophila thorax */
  [-0.07, 0.07].forEach((x) => {
    const s = new THREE.Mesh(new THREE.CapsuleGeometry(0.019, 0.17, 4, 8), dark);
    s.position.set(x, 0.155, -0.01);
    s.rotation.x = Math.PI / 2;
    s.scale.set(1, 1, 0.5);
    body.add(s);
  });
  const scutellum = new THREE.Mesh(new THREE.SphereGeometry(0.095, 14, 10), chitin);
  scutellum.position.set(0, 0.05, -0.185);
  scutellum.scale.set(1.1, 0.6, 0.8);
  body.add(scutellum);
  /* thoracic bristles */
  for (let i = 0; i < 8; i++) {
    const b = new THREE.Mesh(new THREE.ConeGeometry(0.005, 0.07, 4), limb);
    const a = (i / 8) * Math.PI * 2;
    b.position.set(Math.cos(a) * 0.1, 0.15, Math.sin(a) * 0.12 - 0.02);
    b.rotation.set(-0.5 + Math.sin(a) * 0.4, 0, Math.cos(a) * 0.5);
    body.add(b);
  }

  /* abdomen: segmented, tapering, hangs off its own group so it can lag */
  const abdomen = new THREE.Group();
  abdomen.position.set(0, -0.015, -0.16);
  body.add(abdomen);
  /* the pale bands have to be far lighter than the dark ones or the segmented
     abdomen reads as one smooth balloon at any distance */
  const bandLight = new THREE.MeshPhysicalMaterial({
    color: female ? 0xd8b25c : 0x8d96aa, roughness: 0.44, metalness: 0.04,
    clearcoat: 0.4, clearcoatRoughness: 0.45, envMapIntensity: 0.5,
  });
  const nSeg = 5;
  for (let i = 0; i < nSeg; i++) {
    const k = i / (nSeg - 1);
    const r = lerp(0.165, female ? 0.085 : 0.055, k);
    const seg = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 14), i % 2 ? bandLight : dark);
    seg.position.set(0, -k * k * 0.075, -i * (female ? 0.085 : 0.078));
    seg.scale.set(female ? 1.0 : 0.88, 0.82, 0.72);
    abdomen.add(seg);
  }
  if (!female) {
    /* males end in a blunt dark genital arch, females in a pointed ovipositor */
    const tipM = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 10), dark);
    tipM.position.set(0, -0.095, -0.33);
    tipM.scale.set(0.9, 0.85, 0.9);
    abdomen.add(tipM);
  } else {
    const tipF = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.1, 12), dark);
    tipF.position.set(0, -0.085, -0.38);
    tipF.rotation.x = -Math.PI / 2 - 0.35;
    abdomen.add(tipF);
  }

  /* head */
  const head = new THREE.Group();
  head.position.set(0, 0.045, 0.2);
  body.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.135, 22, 18), chitin);
  skull.scale.set(1.0, 0.95, 0.8);
  head.add(skull);
  const face = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), new THREE.MeshPhysicalMaterial({
    color: female ? 0x9c8558 : 0x7c8290, roughness: 0.62, clearcoat: 0.25, envMapIntensity: 0.3,
  }));
  face.position.set(0, -0.015, 0.075);
  face.scale.set(0.85, 1.1, 0.55);
  head.add(face);

  const eyeMat = new THREE.MeshPhysicalMaterial({
    map: female ? T.eyeF : T.eyeM,
    bumpMap: T.eyeBump, bumpScale: 0.008,
    roughness: 0.16, metalness: 0.0,
    clearcoat: 1.0, clearcoatRoughness: 0.06,
    emissive: new THREE.Color(female ? 0x3a0010 : 0x300404), emissiveIntensity: 0.35,
    envMapIntensity: 1.8,
  });
  const eyes = [];
  [-1, 1].forEach((s) => {
    const e = new THREE.Mesh(new THREE.SphereGeometry(0.115, 26, 20), eyeMat);
    e.position.set(s * 0.108, 0.018, 0.022);
    e.scale.set(0.92, 1.16, 1.0);
    e.rotation.y = s * 0.3;
    e.rotation.z = -s * 0.15;
    head.add(e);
    eyes.push(e);
  });
  /* three ocelli on the vertex */
  [[0, 0.1, 0.02], [-0.032, 0.088, -0.005], [0.032, 0.088, -0.005]].forEach((p) => {
    const o = new THREE.Mesh(new THREE.SphereGeometry(0.013, 8, 6), new THREE.MeshStandardMaterial({
      color: 0x201014, roughness: 0.05, metalness: 0.1, emissive: 0x3a1020, emissiveIntensity: 0.4,
    }));
    o.position.set(p[0], p[1], p[2]);
    head.add(o);
  });

  /* antennae with a feathery arista */
  const antennae = [];
  [-1, 1].forEach((s) => {
    const a = new THREE.Group();
    a.position.set(s * 0.042, -0.025, 0.088);
    const seg1 = new THREE.Mesh(new THREE.SphereGeometry(0.019, 8, 6), dark);
    seg1.scale.set(1, 1.2, 1);
    const seg2 = new THREE.Mesh(new THREE.SphereGeometry(0.027, 10, 8), dark);
    seg2.position.y = -0.035;
    seg2.scale.set(1, 1.3, 0.9);
    const arista = new THREE.Group();
    arista.position.set(s * 0.02, -0.045, 0.01);
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0035, 0.0018, 0.12, 4), limb);
    shaft.position.y = 0.055;
    arista.add(shaft);
    for (let i = 0; i < 5; i++) {
      const br = new THREE.Mesh(new THREE.CylinderGeometry(0.0016, 0.0008, 0.042, 3), limb);
      br.position.set(0, 0.02 + i * 0.022, 0);
      br.rotation.z = (i % 2 ? 1 : -1) * 0.95;
      arista.add(br);
    }
    arista.rotation.z = s * 0.5;
    arista.rotation.x = -0.35;
    a.add(seg1, seg2, arista);
    a.userData = { arista };
    head.add(a);
    antennae.push(a);
  });

  /* proboscis: rostrum that extends, labellum that flares to lap */
  const prob = new THREE.Group();
  prob.position.set(0, -0.085, 0.055);
  head.add(prob);
  const rostrum = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.026, 0.07, 10), new THREE.MeshPhysicalMaterial({
    color: 0x6e3226, roughness: 0.35, clearcoat: 0.5, envMapIntensity: 0.6,
  }));
  rostrum.position.y = -0.035;
  prob.add(rostrum);
  const labellum = new THREE.Group();
  labellum.position.y = -0.072;
  prob.add(labellum);
  const lobes = [];
  [-1, 1].forEach((s) => {
    const l = new THREE.Mesh(new THREE.SphereGeometry(0.026, 12, 10), new THREE.MeshPhysicalMaterial({
      color: 0xa85a4a, roughness: 0.28, clearcoat: 0.8, sheen: 0.6, envMapIntensity: 0.8,
    }));
    l.position.set(s * 0.014, -0.012, 0.004);
    l.scale.set(0.85, 0.7, 1.15);
    labellum.add(l);
    lobes.push(l);
  });
  /* The droplet a fly parks on its labellum to concentrate what it drank.
     Hidden at zero scale until the bubble pose asks for it. */
  const bubble = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), new THREE.MeshPhysicalMaterial({
    color: 0xffc66a, roughness: 0.02, metalness: 0.0, transmission: 0.72,
    thickness: 0.06, ior: 1.36, clearcoat: 1.0, envMapIntensity: 2.4,
    /* a little of its own light: fully transmissive glass in a room this dark
       is simply invisible, and this is the one prop the pose is about */
    emissive: 0x9a5d16, emissiveIntensity: 0.35, transparent: true,
  }));
  bubble.scale.setScalar(0.001);
  bubble.visible = false;
  /* Parented to the head, not the labellum it hangs off: the proboscis group
     is scaled 0.3–1.8 in Y to extend it, and anything under it comes out as
     a stretched sliver. It gets placed at the labellum every frame instead. */
  head.add(bubble);

  prob.rotation.x = 0.35;
  prob.scale.y = 0.35;

  /* hat.
     Compound eyes poke above the skull (top ≈ 0.15), so a cap that tries to
     wrap them clips straight through. The trucker cap perches on top of the
     head instead, a bit oversized, bill forward — the silhouette that reads
     from across the bar. */
  const hat = female ? makeBow() : makeTruckerCap();
  hat.position.set(0, female ? 0.125 : MALE_HAT.y, female ? -0.01 : MALE_HAT.z);
  hat.rotation.x = female ? -0.25 : MALE_HAT.rx;
  head.add(hat);

  /* wings: one real pair plus two ghost copies for a cheap motion blur */
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0, 0);
  wingShape.bezierCurveTo(0.14, 0.085, 0.34, 0.075, 0.46, 0.022);
  wingShape.bezierCurveTo(0.36, -0.048, 0.16, -0.05, 0, -0.012);
  const wingGeo = new THREE.ShapeGeometry(wingShape, 26);
  wingGeo.computeBoundingBox();
  {
    const bb = wingGeo.boundingBox;
    const pos = wingGeo.attributes.position;
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      uv[i * 2] = (pos.getX(i) - bb.min.x) / Math.max(1e-6, bb.max.x - bb.min.x);
      uv[i * 2 + 1] = (pos.getY(i) - bb.min.y) / Math.max(1e-6, bb.max.y - bb.min.y);
    }
    wingGeo.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  }
  const wingMatBase = {
    map: T.wing, transparent: true, side: THREE.DoubleSide,
    roughness: 0.06, metalness: 0.1, transmission: 0.55, thickness: 0.004,
    iridescence: 1.0, iridescenceIOR: 1.6, iridescenceThicknessRange: [120, 420],
    envMapIntensity: 1.6, depthWrite: false,
  };
  const wings = [];
  [-1, 1].forEach((s) => {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.085, 0.13, -0.02);
    const mat = new THREE.MeshPhysicalMaterial(Object.assign({}, wingMatBase, { opacity: 0.85 }));
    const blade = new THREE.Mesh(wingGeo, mat);
    blade.scale.set(s, 1, 1);
    pivot.add(blade);
    const ghosts = [];
    for (let i = 0; i < 2; i++) {
      const gm = new THREE.MeshBasicMaterial({
        map: T.wing, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false,
      });
      const gh = new THREE.Mesh(wingGeo, gm);
      gh.scale.set(s, 1, 1);
      const gp = new THREE.Group();
      gp.add(gh);
      pivot.add(gp);
      ghosts.push(gp);
    }
    body.add(pivot);
    wings.push({ pivot, side: s, ghosts });
  });
  /* halteres — the vestigial hind wings. Nobody will name them, everybody
     will feel that the silhouette is right. */
  [-1, 1].forEach((s) => {
    const h = new THREE.Group();
    h.position.set(s * 0.075, 0.03, -0.14);
    const st = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.05, 4), limb);
    st.position.y = 0.025;
    const kn = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), bandLight);
    kn.position.y = 0.055;
    h.add(st, kn);
    h.rotation.z = s * 0.35;
    body.add(h);
  });

  /* legs hang off root, not body, so squash never corrupts the IK */
  const legs = [];
  const hipZ = [0.11, 0.0, -0.12];
  const footZ = [0.26, 0.02, -0.26];
  const footX = [0.30, 0.34, 0.30];
  for (let i = 0; i < 6; i++) {
    const side = i < 3 ? -1 : 1;
    const k = i % 3;
    const leg = buildLeg(root, new THREE.Vector3(side * (k === 1 ? 0.15 : 0.135), -0.065, hipZ[k]), side, i, limb);
    leg.homeOffset.set(side * footX[k], -(bodyY - 0.96), footZ[k]);
    leg.foot.set(homeX + side * footX[k], 0.96, homeZ + footZ[k]);
    legs.push(leg);
  }

  /* contact shadow */
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.85), new THREE.MeshBasicMaterial({
    map: T.blob, transparent: true, opacity: 0.5, depthWrite: false, color: 0x000000,
  }));
  blob.rotation.x = -Math.PI / 2;
  scene.add(blob);

  body.traverse((o) => { if (o.isMesh) o.castShadow = true; });

  return {
    sex, female, root, body, head, abdomen, thorax, eyes, antennae,
    prob, labellum, lobes, bubble, hat, wings, legs, blob, eyeMat,
    home: new THREE.Vector3(homeX, bodyY, homeZ),
    bodyY, baseYaw,
    /* pose state */
    pose: "idle", t: 0, dur: 2.8, prevPose: "idle", place: "stool",
    swing: 0, swingT: 0,
    lookAt: new THREE.Vector3(homeX, bodyY, homeZ - 1),
    /* springs */
    s: {
      px: new Spring(homeX, 90, 15), py: new Spring(bodyY, 120, 17), pz: new Spring(homeZ, 90, 15),
      rx: new Spring(0.06, 110, 16), ry: new Spring(baseYaw, 80, 14), rz: new Spring(0, 110, 16),
      squash: new Spring(1, 200, 16),
      headYaw: new Spring(0, 90, 13), headPitch: new Spring(0, 90, 13),
      abLag: new Spring(0, 70, 11), abLagX: new Spring(0, 70, 11),
      hatY: new Spring(0, 130, 12), hatZ: new Spring(0, 90, 10), hatX: new Spring(0, 130, 12),
      probe: new Spring(0.3, 180, 16), flare: new Spring(0, 150, 14),
      wing: new Spring(0.2, 60, 12),
      solo: new Spring(0, 90, 13), bub: new Spring(0, 60, 14),
      front: new Spring(0, 120, 14),
    },
    lastPos: new THREE.Vector3(homeX, bodyY, homeZ),
  };
}

/* Where a fly ends up once it has come off its stool. `fall` animates to it,
   `down` rests on it and `climb` starts from it, so a fly that is already on
   the floor never has to snap back onto the stool to get there again. */
const FLOOR_Y = 0.14;
function floorSpot(home) {
  const side = home.x > 0 ? 1 : -1;
  /* forward off the stool rather than sideways: landing further out puts the
     fly behind the deep table on one side and the jukebox on the other */
  return { x: home.x + side * 0.14, y: FLOOR_Y, z: home.z + 0.55, side };
}
/* the sprawl: rolled onto one side, nose up, hat somewhere else entirely */
const SPRAWL = { rz: 1.25, rx: 0.76, ry: 1.1 };

/* Poses that describe a fly at rest on its stool. If it is on the floor
   instead, these have to become `down` or the fly teleports up. */
const RESTING = new Set(["idle", "wait", "nap", "lose", "beg"]);

/* Where a fly hanging upside down puts its feet, and the bulb it keeps
   flying into. Both match the props stage.js builds. */
const CEILING_Y = 2.97;
const LAMP = { x: 0, y: 2.34, z: -0.1 };

/** The pose actually played, given where the fly currently is. */
export function resolvePose(pose, place) {
  if (place !== "floor") return pose === "down" ? "fall" : pose;
  if (pose === "fall") return "down";       // already down: do not topple again
  return RESTING.has(pose) ? "down" : pose;
}

/* ------------------------------------------------------------------ *
 * poses. Each returns spring TARGETS plus a few discrete flags.
 * `u` is 0→1 across the beat, `t` is wall time for idle noise.
 * ------------------------------------------------------------------ */
export function posePlan(pose, u, t, rig, ctx) {
  const home = rig.home;
  const side = home.x > 0 ? 1 : -1;      // +1 = male (right stool)
  const inward = -side;                   // toward the middle of the bar
  /* Yaw is the other way round, and it is not obvious why: the flies sit
     splayed outward at baseYaw = π ∓ 0.85 for the three-quarter view, so
     swinging one to face its neighbour means adding yaw in the direction of
     its own side, not toward the middle. Moving inward is `inward`; looking
     inward is `turn`. */
  const turn = side;
  /* And a fly doing something with its face — wiping its eyes, balancing a
     droplet on its proboscis — has to swing right round off the counter and
     show the room, or the camera gets three-quarters of an abdomen. */
  const toRoom = -side * (Math.PI - 0.85);
  const p = {
    x: home.x, y: home.y, z: home.z,
    rx: 0.06, ry: 0, rz: 0,
    squash: 1,
    look: null,            // world point, or null → default
    grounded: true,
    wing: 0.18,
    wingSpd: 26,
    probe: 0.3,
    flare: 0,
    hatX: 0, hatY: 0, hatZ: 0,
    solo: 0,        // courtship song: one wing out, -1 left / +1 right
    bubble: 0,      // droplet on the labellum
    front: 0,       // front pair of legs off the ground (grooming, begging)
    gait: 0,
  };
  const wob = ctx.instability;

  if (pose === "idle" || pose === "wait") {
    /* drunk sway: slow figure-eight, amplitude straight off CX instability */
    p.x += Math.sin(t * 1.25 + home.x * 3) * wob * 0.11;
    p.z += Math.sin(t * 0.83 + home.x) * wob * 0.06;
    p.rz = -Math.sin(t * 1.25 + home.x * 3) * wob * 0.5 + ctx.lean * 0.3;
    p.rx = 0.06 + Math.sin(t * 1.9) * 0.035 + wob * 0.12;
    p.ry = ctx.heading * 0.5 + Math.sin(t * 0.47) * 0.16;
    p.y = home.y + Math.sin(t * 2.6) * 0.006;
    p.wing = 0.1 + wob * 0.25;
    p.probe = 0.25 + clamp(ctx.mn9 / 60, 0, 0.5);
    p.look = (Math.sin(t * 0.31) > 0.1) ? ctx.rival : ctx.glass;
  } else if (pose === "drink" || pose === "shot") {
    /* anticipation → lunge → three laps → sit back and groom */
    const reach = pulse(u, 0.08, 0.62);
    const back = ramp(u, 0.68, 1.0);
    p.z = lerp(home.z - 0.30 * reach, home.z, back);
    p.y = home.y - 0.035 * reach + 0.02 * ramp(u, 0, 0.08);
    p.rx = 0.06 - 0.5 * reach + 0.14 * pulse(u, 0, 0.1);
    p.ry = inward * 0.12;
    p.squash = 1 - 0.07 * reach;
    p.look = ctx.glass;
    p.wing = 0.06;
    p.gait = reach * 0.6;
    /* the lapping itself: labellum flares and pumps three times */
    const lap = (u > 0.2 && u < 0.6) ? Math.abs(Math.sin((u - 0.2) * Math.PI * 6)) : 0;
    p.probe = 0.3 + reach * 0.9 + lap * 0.25;
    p.flare = lap;
    if (u > 0.72) { p.probe = 0.25; p.rx = 0.16; }
  } else if (pose === "spin") {
    /* up onto the counter, rear back, haul the lever down, drop off again */
    const walk = ramp(u, 0.02, 0.3);
    const back = ramp(u, 0.72, 1.0);
    p.x = lerp(lerp(home.x, side * 0.44, walk), home.x, back);
    p.z = lerp(lerp(home.z, -0.42, walk), home.z, back);
    p.y = lerp(lerp(home.y, BAR_STAND_Y, walk), home.y, back);
    p.ry = inward * 0.75 * (walk - back);
    const rear = pulse(u, 0.32, 0.52);
    const haul = ramp(u, 0.46, 0.6) * (1 - ramp(u, 0.62, 0.72));
    p.rx = 0.06 - rear * 0.55 + haul * 0.5;
    p.y += rear * 0.09 - haul * 0.05;
    p.squash = 1 + rear * 0.1 - haul * 0.12;
    p.gait = (walk - back) > 0.05 && u < 0.32 ? 1.2 : 0.15;
    p.look = ctx.slot;
    p.wing = 0.12 + rear * 0.5;
  } else if (pose === "win") {
    /* four hops, each a real anticipation-launch-land, hat lagging behind */
    const hops = 4;
    const hu = (u * hops) % 1;
    const h = Math.sin(clamp(hu, 0, 1) * Math.PI);
    const crouch = hu < 0.12 ? 1 : 0;
    p.y = home.y + h * h * 0.30;
    p.squash = 1 + h * 0.14 - crouch * 0.18;
    p.grounded = h > 0.12 ? false : true;
    p.rx = 0.06 - h * 0.3;
    p.rz = Math.sin(u * 13) * 0.22;
    p.ry = Math.sin(u * 7.5) * 0.5;
    p.hatY = h * 0.09;
    p.hatZ = Math.sin(u * 19) * 0.55;
    p.wing = 0.5 + h * 0.4;
    p.wingSpd = 46;
    p.look = ctx.cam;
    p.probe = 0.9;
  } else if (pose === "lose") {
    /* the whole body deflates, then one slow slump */
    const k = smooth(ramp(u, 0, 0.35));
    const sag = ramp(u, 0.4, 1.0);
    p.rx = 0.06 + k * 0.55 + sag * 0.12;
    p.y = home.y - k * 0.10 - sag * 0.035;
    p.squash = 1 - k * 0.14;
    p.ry = inward * 0.25;
    p.rz = side * 0.12 * sag;
    p.hatZ = -0.4 * k;
    p.hatY = -0.02 * k;
    p.wing = 0.03;
    p.wingSpd = 7;
    p.probe = 0.15;
    p.look = ctx.slot;
  } else if (pose === "steal") {
    /* up onto the counter, creep across low, one held beat over the loot,
       snatch, then scurry home without looking back */
    const mount = ramp(u, 0.03, 0.22);
    const cross = ramp(u, 0.22, 0.50);
    const grab = pulse(u, 0.50, 0.64);
    const flee = ramp(u, 0.66, 0.97);
    const out = cross * (1 - flee);
    p.x = lerp(lerp(lerp(home.x, side * 0.5, mount), -side * 0.46, cross), home.x, flee);
    p.z = lerp(lerp(home.z, -0.42, mount), home.z, flee);
    p.y = lerp(lerp(home.y, BAR_STAND_Y, mount), home.y, flee) - out * 0.05 - grab * 0.03;
    p.rx = 0.06 + out * 0.25 - grab * 0.3;
    p.ry = -inward * 1.35 * out + inward * 1.35 * flee;
    p.squash = 1 - out * 0.09 + grab * 0.06;
    p.gait = (mount > 0.02 && flee < 0.02) ? 1.7 : (flee > 0.02 && flee < 0.98 ? 2.5 : 0.1);
    p.wing = 0.05;
    p.look = flee > 0.12 ? ctx.rival : ctx.chips;
  } else if (pose === "fall") {
    /* topple off the stool: a moment of wobble, then over, then twitching */
    const f = floorSpot(home);
    const teeter = ramp(u, 0, 0.16);
    const k = smooth(ramp(u, 0.16, 0.5));
    const bounce = u > 0.5 ? Math.abs(Math.sin((u - 0.5) * 16)) * Math.exp(-(u - 0.5) * 7) : 0;
    p.rz = side * (teeter * 0.4 + k * SPRAWL.rz);
    p.rx = 0.06 + k * (SPRAWL.rx - 0.06);
    p.y = lerp(home.y, f.y, k) + bounce * 0.09;
    p.x = lerp(home.x, f.x, k);
    p.z = lerp(home.z, f.z, k);
    p.ry = side * k * SPRAWL.ry;
    p.squash = 1 - bounce * 0.2;
    p.grounded = false;
    p.hatX = side * k * 0.4;
    p.hatY = -k * 0.2;
    p.hatZ = k * 2.4;
    p.wing = u > 0.55 ? 0.6 * Math.exp(-(u - 0.55) * 5) : 0.04;
    p.wingSpd = 40;
    p.look = ctx.cam;
    p.probe = 0.9;
  } else if (pose === "down") {
    /* Already on the floor. Do not re-play the topple — just be a fly lying
       there: breathing, and every few seconds one half-hearted attempt at
       getting up that comes to nothing. */
    const f = floorSpot(home);
    const breathe = Math.sin(t * 1.15);
    /* offset per fly so the two never twitch in unison */
    const cycle = (t * 0.26 + (side > 0 ? 0.37 : 0.81)) % 1;
    const flail = cycle < 0.2 ? Math.sin((cycle / 0.2) * Math.PI) : 0;
    p.x = f.x + flail * side * 0.03;
    p.y = f.y + flail * 0.04 + breathe * 0.005;
    p.z = f.z - flail * 0.02;
    p.rz = side * (SPRAWL.rz - flail * 0.22);
    p.rx = SPRAWL.rx + breathe * 0.04 - flail * 0.1;
    p.ry = side * SPRAWL.ry + side * flail * 0.25;
    p.squash = 1 + breathe * 0.03 - flail * 0.06;
    p.grounded = false;                  // legs wave in the air, as they should
    p.wing = 0.03 + flail * 0.75;
    p.wingSpd = 44;
    p.probe = 0.2 + flail * 0.5;
    p.look = flail > 0.35 ? ctx.cam : null;
    /* the hat came off on the way down and has not moved since */
    p.hatX = side * 0.4;
    p.hatY = -0.2;
    p.hatZ = 2.4;
  } else if (pose === "climb") {
    /* three grabs up the stool leg, each with a slip back */
    const f = floorSpot(home);
    const grabs = 3;
    const gu = (u * grabs) % 1;
    const gain = (Math.floor(u * grabs) + smooth(clamp(gu * 1.6, 0, 1)) - (gu > 0.8 ? 0.22 : 0)) / grabs;
    p.y = lerp(f.y, home.y, clamp(gain, 0, 1));
    p.x = lerp(f.x, home.x, clamp(gain, 0, 1));
    p.z = lerp(f.z, home.z, clamp(gain, 0, 1));
    /* the sprawl unwinds over the first grab, rather than snapping upright */
    const rise = smooth(clamp(u * 3, 0, 1));
    p.rz = side * SPRAWL.rz * (1 - rise) + Math.sin(u * 9) * 0.16 * rise;
    p.ry = side * SPRAWL.ry * (1 - rise);
    p.hatX = side * 0.4 * (1 - rise);
    p.hatY = -0.2 * (1 - rise);
    p.hatZ = 2.4 * (1 - rise);
    p.rx = lerp(SPRAWL.rx, -0.55 + Math.sin(gu * Math.PI * 2) * 0.15, rise);
    p.grounded = false;
    p.gait = 2.4;
    p.wing = 0.35 + (gu > 0.75 ? 0.4 : 0);
    p.wingSpd = 36;
    p.look = ctx.glass;
  } else if (pose === "nap") {
    const settle = smooth(ramp(u, 0, 0.3));
    const breathe = Math.sin(t * 1.5) * 0.5 + 0.5;
    p.y = home.y - 0.085 * settle;
    p.z = home.z - 0.1 * settle;
    p.rx = 0.06 + 0.75 * settle;
    p.ry = inward * 0.3;
    p.rz = side * 0.2 * settle;
    p.squash = 1 - 0.1 * settle + breathe * 0.035;
    p.wing = 0.015;
    p.wingSpd = 4;
    p.probe = 0.1;
    p.look = null;
  } else if (pose === "beg") {
    /* front legs off the ground, rocking. Universally legible. */
    const rock = Math.sin(u * Math.PI * 5);
    p.rx = -0.4 - rock * 0.12;
    p.y = home.y + 0.035;
    p.z = home.z - 0.05;
    p.ry = inward * 0.55;
    p.rz = rock * 0.1;
    p.squash = 1.04;
    p.wing = 0.28;
    p.probe = 0.55;
    p.look = ctx.rival;
  } else if (pose === "borrow") {
    /* onto the counter, up on the hind legs at the barman, back down */
    const go = ramp(u, 0.05, 0.4);
    const back = ramp(u, 0.68, 1.0);
    const ask = pulse(u, 0.42, 0.66);
    p.x = lerp(lerp(home.x, side * 0.32, go), home.x, back);
    p.z = lerp(lerp(home.z, -0.5, go), home.z, back);
    p.y = lerp(lerp(home.y, BAR_STAND_Y, go), home.y, back) + ask * 0.04;
    p.ry = inward * 0.6 * (go - back);
    p.rx = 0.06 - ask * 0.45;
    p.gait = (go > 0.03 && back < 0.97) ? 1.3 : 0.1;
    p.wing = 0.15;
    p.look = ctx.barman;
  } else if (pose === "groom") {
    /* The real sequence, in the real order: rear up and wipe the eyes with
       the front pair, scrub the proboscis, then cross the hind legs over the
       wings. Everyone has watched a fly do exactly this on a windowsill. */
    const eyes = pulse(u, 0.05, 0.45);
    const face = pulse(u, 0.42, 0.62);
    const back = pulse(u, 0.60, 0.95);
    const scrub = Math.sin(u * Math.PI * 26);
    p.y = home.y + eyes * 0.045 + back * 0.01;
    p.rx = 0.06 - eyes * 0.42 + back * 0.30;
    p.rz = (eyes + face) * scrub * 0.09;
    p.ry = toRoom * smooth(ramp(u, 0.0, 0.22)) * 0.85
         + Math.sin(u * Math.PI * 13) * (eyes + face) * 0.13;
    p.squash = 1 + eyes * 0.05 - back * 0.05;
    p.front = eyes + face;                  // front pair up at the eyes
    p.probe = 0.2 + face * 0.8;
    p.flare = face * 0.6;
    p.wing = 0.04 + back * 0.32;            // hind legs disturb the wings
    p.wingSpd = 12;
    p.hatZ = scrub * (eyes + face) * 0.22;
    p.look = null;
  } else if (pose === "work") {
    /* Up on the counter, nose down, hauling a rag back and forth. The whole
       body drives the stroke, because a fly has no shoulders to do it with. */
    const up = ramp(u, 0.04, 0.24);
    const off = ramp(u, 0.82, 1.0);
    const on = up - off;
    const stroke = Math.sin(u * Math.PI * 7);
    p.x = lerp(home.x, home.x * 0.45 + stroke * 0.3, on);
    p.z = lerp(home.z, -0.42 + Math.abs(stroke) * 0.06, on);
    p.y = lerp(home.y, BAR_STAND_Y, on) - on * Math.abs(stroke) * 0.012;
    p.rx = 0.06 + on * (0.34 + stroke * 0.12);
    p.ry = on * stroke * 0.5;
    p.rz = on * stroke * -0.16;
    p.squash = 1 - on * 0.06;
    p.gait = (up > 0.03 && off < 0.97) ? 1.6 : 0.2;
    p.wing = 0.05;
    p.probe = 0.25;
    p.look = on > 0.5 ? null : ctx.barman;
  } else if (pose === "scrounge") {
    /* Down on the boards, nose to the floor, quartering the ground in a
       little search spiral. Head sweeps, abdomen high. */
    const down = ramp(u, 0.04, 0.22);
    const up = ramp(u, 0.86, 1.0);
    const on = down - up;
    const a = u * Math.PI * 3.4;
    const spot = floorSpot(home);
    /* A fly that is already on the floor searches from where it is lying and
       stays there; one on its stool hops down and climbs back up after. */
    const onFloor = rig.place === "floor";
    const bx = onFloor ? spot.x : home.x, bz = onFloor ? spot.z : home.z;
    const by = onFloor ? FLOOR_Y : home.y;
    /* a tight circuit, not a tour: wander further than this and the fly
       ends up behind a stool leg or the deep table */
    p.x = lerp(bx, spot.x + Math.cos(a) * 0.17, on);
    p.z = lerp(bz, spot.z + Math.sin(a) * 0.12, on);
    p.y = lerp(by, FLOOR_Y + 0.012, on);
    p.rx = 0.06 + on * 0.52;                // face down, tail up
    p.ry = on * Math.sin(u * Math.PI * 9) * 0.6;
    p.rz = on * Math.sin(u * Math.PI * 6) * 0.1;
    p.squash = 1 - on * 0.05;
    p.gait = on > 0.2 ? 2.2 : 0.2;
    p.wing = 0.04;
    p.probe = 0.25 + on * 0.75;             // tasting the floor, obviously
    p.flare = on * pulse(u, 0.3, 0.8) * 0.8;
    p.look = null;
  } else if (pose === "lamp") {
    /* Straight up at the bulb, a solid bonk, then a stunned tumble home.
       Positive phototaxis is the single most fly thing a fly does. */
    const climb = ramp(u, 0.06, 0.40);
    const hit = pulse(u, 0.40, 0.50);
    const fallBack = ramp(u, 0.48, 0.92);
    const bonk = u > 0.4 && u < 0.62 ? Math.sin((u - 0.4) * Math.PI * 9) * Math.exp(-(u - 0.4) * 12) : 0;
    p.x = lerp(lerp(home.x, LAMP.x + side * 0.1, climb), home.x, fallBack) + bonk * side * 0.18;
    p.z = lerp(lerp(home.z, LAMP.z, climb), home.z, fallBack);
    p.y = lerp(lerp(home.y, LAMP.y, climb), home.y, fallBack) - bonk * 0.12
        + Math.sin(u * Math.PI * 11) * climb * (1 - fallBack) * 0.03;
    p.rx = -0.3 * climb + fallBack * 0.5 + bonk * 1.2;
    p.rz = bonk * 2.6 + fallBack * (1 - fallBack) * side * 2.0;
    p.ry = Math.sin(u * Math.PI * 5) * 0.4;
    p.grounded = u > 0.06 && u < 0.95 ? false : true;
    p.wing = 0.85 - hit * 0.5;
    p.wingSpd = 62;
    p.squash = 1 - hit * 0.12;
    p.hatZ = bonk * 3.0;
    p.hatY = -Math.abs(bonk) * 0.1;
    p.probe = 0.3 + hit * 0.7;
    p.look = u < 0.45 ? _lampV.set(LAMP.x, LAMP.y, LAMP.z) : ctx.cam;
  } else if (pose === "ceiling") {
    /* Up the back wall and out across the ceiling, upside down. The feet
       stay planted the whole way — supportY hands back the ceiling once the
       body is up there, so the same IK that walks the counter walks this. */
    const rise = ramp(u, 0.02, 0.32);
    const flip = ramp(u, 0.22, 0.44);
    const walk = ramp(u, 0.44, 1.0);
    p.x = lerp(home.x, home.x * 0.5 - side * 0.5 * walk, rise);
    /* forward, over the stools rather than back over the counter: that is
       the patch of ceiling the camera can actually see the fly against */
    p.z = lerp(home.z, 0.15 + walk * 0.45, rise);
    /* hanging: the body sits a full leg's reach BELOW its feet, same
       0.31 the fly stands at right way up */
    p.y = lerp(home.y, CEILING_Y - 0.31, rise);
    p.rz = flip * Math.PI;                  // roll over onto the ceiling
    p.rx = -0.5 * (rise - flip) + 0.04;
    p.ry = walk * side * 0.5 + Math.sin(u * Math.PI * 3) * 0.12;
    p.grounded = flip > 0.9;                // fly up, then plant six feet
    p.wing = flip > 0.92 ? 0.05 : 0.8;
    p.wingSpd = 58;
    p.gait = walk > 0.05 ? 1.4 : 0.2;
    p.squash = 1 - rise * 0.03;
    p.hatZ = flip * 0.5;
    p.look = walk > 0.3 ? ctx.cam : null;
  } else if (pose === "sing") {
    /* One wing swung out square to the body and buzzed: the courtship song.
       The fly sidles along an arc in front of the audience while it plays. */
    const out = ramp(u, 0.06, 0.24);
    const stop = ramp(u, 0.88, 1.0);
    const on = out - stop;
    const sidle = Math.sin(u * Math.PI * 4);
    p.x = home.x + on * inward * (0.18 + sidle * 0.12);
    p.z = home.z + on * (0.07 + Math.abs(sidle) * 0.05);
    p.y = home.y + on * 0.02;
    p.ry = turn * (0.9 + on * 0.55) + sidle * 0.18;
    p.rx = 0.06 - on * 0.18;
    p.rz = on * sidle * 0.12;
    p.squash = 1 + on * 0.04;
    p.solo = on * inward;                   // which wing goes out
    p.wing = 0.06;
    p.wingSpd = 20;
    p.gait = Math.abs(sidle) > 0.25 && on > 0.4 ? 1.3 : 0.2;
    p.probe = 0.35;
    p.hatZ = sidle * 0.2;
    p.look = ctx.rival;
  } else if (pose === "toast") {
    /* Lean in, reach up, hold at the top for the clink, drink, sit back.
       Both flies play this on the same beat, so the timings must match. */
    const lean = ramp(u, 0.05, 0.3);
    const lift = pulse(u, 0.22, 0.55);
    const clink = u > 0.36 && u < 0.46 ? Math.sin((u - 0.36) * Math.PI * 10) : 0;
    const sip = pulse(u, 0.55, 0.82);
    /* Nearly two metres of counter between the stools, so a polite lean
       reads as two strangers. They have to properly commit to the middle. */
    p.x = home.x + lean * inward * 0.58;
    p.z = home.z + lean * 0.06;
    p.y = home.y + lift * 0.07 + clink * 0.02;
    p.ry = turn * (1.5 * lean) * (1 - sip * 0.45);
    p.rx = 0.06 - lift * 0.3 + sip * 0.34;
    p.rz = inward * (lift * 0.2 - clink * 0.5);
    p.squash = 1 + lift * 0.05 - sip * 0.06;
    p.front = lift;                         // both front legs up on the glass
    p.wing = 0.1 + clink * 0.5;
    p.wingSpd = 34;
    p.probe = 0.3 + sip * 1.1;
    p.flare = sip * Math.abs(Math.sin(u * Math.PI * 9));
    p.hatZ = clink * 0.8 - lift * 0.15;
    p.look = sip > 0.2 ? ctx.glass : ctx.rival;
  } else if (pose === "shove") {
    /* Nearly two metres of counter separate the stools, so a shove has to be
       a crossing, not a lean: crouch, launch, barge in shoulder-first, bounce
       off and buzz back to your own seat pretending it was nothing. */
    const crouch = pulse(u, 0.02, 0.22);
    const cross = ramp(u, 0.16, 0.44);
    const back = ramp(u, 0.60, 0.94);
    const out = cross * (1 - back);
    const hit = u > 0.44 && u < 0.66 ? Math.sin((u - 0.44) * Math.PI * 4.5) * Math.exp(-(u - 0.44) * 9) : 0;
    p.x = lerp(lerp(home.x - crouch * inward * 0.08, -side * 0.62, cross), home.x, back);
    p.z = lerp(home.z + out * 0.06, home.z, back);
    p.y = lerp(home.y + out * 0.10, home.y, back) - Math.abs(hit) * 0.05;
    p.ry = turn * (1.15 * out + 0.5 * back);
    p.rx = 0.06 + crouch * 0.16 - out * 0.34 + hit * 0.5;
    p.rz = turn * (-crouch * 0.2 + out * 0.5) - hit * turn * 1.1;
    p.squash = 1 - crouch * 0.12 + out * 0.07;
    p.grounded = cross > 0.05 && back < 0.9 ? false : true;
    p.gait = 2.2;
    p.wing = 0.1 + out * 0.7 + Math.abs(hit) * 0.3;
    p.wingSpd = 50;
    p.hatZ = -hit * 2.2 - out * 0.35;
    p.hatY = -Math.abs(hit) * 0.07;
    p.probe = 0.2;
    p.look = back > 0.2 ? ctx.cam : ctx.rival;
  } else if (pose === "bubble") {
    /* Roll the droplet out onto the labellum, hold it there looking pleased
       with itself, then suck it back in. Twice. */
    /* One droplet, held. Two cycles per beat meant the bubble was retracted
       as often as it was out, which is a coin flip on whether anybody sees
       the thing the whole beat is named after. */
    const outw = pulse(u, 0.10, 0.90);
    p.y = home.y + Math.sin(t * 2.4) * 0.006 + outw * 0.012;
    p.rx = 0.06 - outw * 0.26;              // head tips back to balance it
    p.ry = toRoom * smooth(ramp(u, 0.0, 0.25)) * 0.9 + Math.sin(t * 0.5) * 0.12;
    p.rz = Math.sin(t * 1.3) * 0.04 * (1 + ctx.instability);
    p.squash = 1 + outw * 0.03;
    p.probe = 0.35 + outw * 0.95;
    p.flare = outw * 0.5;
    p.bubble = outw;
    p.wing = 0.03;
    p.wingSpd = 8;
    p.look = u > 0.5 ? ctx.cam : null;
  }

  /* alcohol wobble rides on top of every pose except the floor ones */
  if (pose !== "fall" && pose !== "down" && pose !== "nap") {
    p.rz += Math.sin(t * 2.7 + home.x * 2) * wob * 0.16;
    p.x += Math.sin(t * 1.9 + home.x) * wob * 0.02;
  }
  return p;
}

/* ------------------------------------------------------------------ *
 * where a foot can rest at a given spot
 * ------------------------------------------------------------------ */
function supportY(x, z, bodyY) {
  if (bodyY > 2.6) return CEILING_Y;                               // hanging upside down
  if (bodyY < 0.62) return 0.035;                                  // floor
  const onBar = clamp((-0.10 - z) / 0.26, 0, 1);                   // blend onto the counter
  return lerp(0.962, 1.045, smooth(onBar));
}

const STEP_TIME = 0.16;
const STEP_TRIGGER = 0.085;

function updateLegs(rig, dt, grounded, gait, front) {
  const root = rig.root;
  let anyStepping = false;
  for (let i = 0; i < 6; i++) {
    const leg = rig.legs[i];
    /* `front` lifts only the leading pair — that is the whole read of a fly
       grooming its eyes or propping itself on a glass, and it has to leave
       the other four planted or the body loses its footing. */
    const lifted = front > 0.5 && leg.idx % 3 === 0;
    if (lifted) {
      _v.set(leg.side * 0.20, 0.10 + Math.sin(rig.t * 30 + leg.side) * 0.03, 0.22)
        .applyQuaternion(root.quaternion).add(root.position);
      leg.foot.lerp(_v, 1 - Math.exp(-20 * dt));
      leg.stepT = 1;
    } else if (grounded) {
      _v.copy(leg.homeOffset).applyQuaternion(root.quaternion).add(root.position);
      _v.y = supportY(_v.x, _v.z, root.position.y);
      if (leg.stepT < 1) {
        anyStepping = true;
        leg.stepT += dt / STEP_TIME;
        const k = clamp(leg.stepT, 0, 1);
        leg.foot.lerpVectors(leg.stepFrom, leg.stepTo, smooth(k));
        leg.foot.y += Math.sin(k * Math.PI) * (0.045 + gait * 0.02);
        if (leg.stepT >= 1) leg.foot.copy(leg.stepTo);
      } else {
        const err = leg.foot.distanceTo(_v);
        if (err > 0.55) {
          leg.foot.copy(_v);                                        // teleported; don't walk there
        } else if (err > STEP_TRIGGER && leg.tripod === rig.swing) {
          leg.stepFrom.copy(leg.foot);
          leg.stepTo.copy(_v);
          leg.stepT = 0;
          anyStepping = true;
        }
      }
    } else {
      /* airborne: legs tuck under and trail */
      _v.set(leg.side * 0.22, -0.19, leg.homeOffset.z * 0.7)
        .applyQuaternion(root.quaternion).add(root.position);
      leg.foot.lerp(_v, 1 - Math.exp(-14 * dt));
      leg.stepT = 1;
    }
    _v2.copy(leg.foot);
    root.worldToLocal(_v2);
    solveLeg(leg, _v2);
  }
  rig.swingT += dt;
  if (!anyStepping && rig.swingT > 0.08) { rig.swing ^= 1; rig.swingT = 0; }
}

/* ------------------------------------------------------------------ *
 * per-frame update
 * ------------------------------------------------------------------ */
export function updateFly(rig, ctx, dt, t) {
  rig.t += dt;
  const u = clamp(rig.t / rig.dur, 0, 1);
  const plan = posePlan(rig.pose, u, t, rig, ctx);
  const s = rig.s;

  s.px.target = plan.x; s.py.target = plan.y; s.pz.target = plan.z;
  /* a standing bias so the default attitude is head-up and propped on the
     bar rather than flat along the seat */
  s.rx.target = plan.rx - 0.16;
  s.ry.target = rig.baseYaw + plan.ry;
  s.rz.target = plan.rz;
  s.squash.target = plan.squash;
  s.hatX.target = plan.hatX; s.hatY.target = plan.hatY; s.hatZ.target = plan.hatZ;
  s.probe.target = plan.probe;
  s.flare.target = plan.flare;
  s.wing.target = plan.wing;
  s.solo.target = plan.solo;
  s.bub.target = plan.bubble;
  s.front.target = plan.front;

  rig.lastPos.copy(rig.root.position);
  rig.root.position.set(s.px.step(dt), s.py.step(dt), s.pz.step(dt));
  rig.root.rotation.set(s.rx.step(dt), s.ry.step(dt), s.rz.step(dt));
  /* world matrices must be current: the leg IK and the head aim both
     convert world-space targets back into rig space this same frame */
  rig.root.updateMatrixWorld(true);

  /* body squash, volume-preserving-ish */
  const sq = s.squash.step(dt);
  rig.body.scale.set(1 / Math.sqrt(sq), sq, 1 / Math.sqrt(sq));

  /* abdomen lags behind the thorax — the cheapest convincing weight cue */
  const vel = _v.copy(rig.root.position).sub(rig.lastPos).divideScalar(Math.max(dt, 1e-4));
  s.abLag.target = clamp(-vel.z * 0.05, -0.5, 0.5);
  s.abLagX.target = clamp(-vel.x * 0.05, -0.5, 0.5);
  rig.abdomen.rotation.x = s.abLag.step(dt);
  rig.abdomen.rotation.y = s.abLagX.step(dt);

  /* head aim */
  if (plan.look) {
    _v2.copy(plan.look);
    rig.body.worldToLocal(_v2).sub(rig.head.position);
    const len = Math.max(_v2.length(), 1e-4);
    s.headYaw.target = clamp(Math.atan2(_v2.x, _v2.z), -0.95, 0.95);
    s.headPitch.target = clamp(-Math.asin(clamp(_v2.y / len, -1, 1)), -0.55, 0.65);
  } else {
    s.headYaw.target = Math.sin(t * 0.6) * 0.1;
    s.headPitch.target = 0.15;
  }
  rig.head.rotation.y = s.headYaw.step(dt);
  rig.head.rotation.x = s.headPitch.step(dt);

  /* wings: flap plus two ghost copies at trailing phases */
  const amp = s.wing.step(dt);
  const ph = t * plan.wingSpd;
  /* The courtship song is not a flap. One wing swings out square to the body
     and buzzes through a few degrees while the other stays folded — that
     asymmetry is the entire signal, both for a fly and for a viewer. */
  const solo = s.solo.step(dt);
  const song = Math.sin(t * 150) * 0.16;
  rig.wings.forEach((w) => {
    const base = -w.side * 0.5;
    const sings = Math.abs(solo) > 0.05 && Math.sign(solo) === w.side;
    if (sings) {
      const k = Math.abs(solo);
      w.pivot.rotation.z = base + w.side * k * 1.45 + song * k * w.side;
      w.pivot.rotation.x = 0.12 - k * 0.5;
      w.pivot.rotation.y = -w.side * (0.25 - k * 1.15);
      w.ghosts.forEach((g, i) => {
        g.rotation.z = -song * (i + 1) * 0.45 * k * w.side;
        g.children[0].material.opacity = clamp(k * 0.2, 0, 0.16);
      });
      return;
    }
    w.pivot.rotation.z = base + Math.sin(ph) * amp * w.side;
    w.pivot.rotation.x = 0.12 + Math.sin(ph * 0.5) * amp * 0.35;
    w.pivot.rotation.y = -w.side * (0.25 - amp * 0.35);
    w.ghosts.forEach((g, i) => {
      g.rotation.z = (Math.sin(ph - (i + 1) * 0.55) - Math.sin(ph)) * amp * w.side;
      g.children[0].material.opacity = clamp(amp * 0.22, 0, 0.16);
    });
  });

  /* antennae spring about; they droop when octopamine is up */
  const droop = clamp(ctx.oa * 0.8, 0, 0.6) + (rig.pose === "lose" || rig.pose === "nap" ? 0.45 : 0);
  rig.antennae.forEach((a, i) => {
    const sgn = i ? 1 : -1;
    a.rotation.z = sgn * (0.2 + Math.sin(t * 5.5 + i * 2) * 0.09) - droop * sgn * 0.3;
    a.rotation.x = -0.15 + droop * 0.7 + Math.sin(t * 3.7 + i) * 0.07;
  });

  /* proboscis: extend + flare. MN9 drives the resting length directly. */
  const pe = s.probe.step(dt);
  rig.prob.scale.y = 0.3 + pe * 1.5;
  rig.prob.rotation.x = 0.35 + pe * 0.45;
  const fl = s.flare.step(dt);
  rig.lobes.forEach((l, i) => {
    const sgn = i ? 1 : -1;
    l.position.x = sgn * (0.014 + fl * 0.016);
    l.scale.set(0.85 + fl * 0.35, 0.7, 1.15 + fl * 0.3);
  });

  /* the droplet, sat on the end of whatever length the proboscis is at */
  const bub = s.bub.step(dt);
  rig.bubble.visible = bub > 0.02;
  if (rig.bubble.visible) {
    rig.head.updateMatrixWorld(true);
    rig.labellum.getWorldPosition(_v2);
    rig.head.worldToLocal(_v2);
    const wob2 = 1 + Math.sin(t * 9) * 0.07 * bub;
    rig.bubble.scale.set(bub * wob2, bub / wob2, bub * wob2);
    rig.bubble.position.set(_v2.x, _v2.y - bub * 0.045, _v2.z + bub * 0.02);
  }

  /* hat with its own spring + a little inertia from body motion */
  rig.hat.position.x = s.hatX.step(dt);
  rig.hat.position.y = (rig.female ? 0.125 : MALE_HAT.y) + s.hatY.step(dt);
  rig.hat.rotation.z = s.hatZ.step(dt);
  rig.hat.rotation.x = (rig.female ? -0.25 : MALE_HAT.rx) + clamp(vel.z * 0.03, -0.3, 0.3);
  if (rig.hat.userData.tails) {
    const tails = rig.hat.userData.tails;
    tails.rotation.x = tails.userData.rest + clamp(-vel.z * 0.12, -0.7, 0.7) + Math.sin(t * 3.1) * 0.08;
  }

  /* eyes: dopamine warms them, octopamine cools and dims them */
  const warm = clamp(ctx.da - ctx.oa, -1, 1);
  rig.eyeMat.emissiveIntensity = 0.22 + clamp(ctx.da, 0, 1) * 0.7;
  rig.eyeMat.emissive.setHSL(warm > 0 ? 0.33 : 0.98, 0.9, 0.12 + Math.abs(warm) * 0.1);

  updateLegs(rig, dt, plan.grounded, plan.gait, s.front.step(dt));

  /* contact shadow tightens as the fly gets closer to its surface. Up on the
     ceiling the surface is above the fly, so there is nothing to cast onto. */
  const surf = supportY(rig.root.position.x, rig.root.position.z, rig.root.position.y);
  rig.blob.visible = surf < rig.root.position.y;
  const lift = clamp(rig.root.position.y - surf - 0.2, 0, 0.6);
  rig.blob.position.set(rig.root.position.x, surf + 0.004, rig.root.position.z);
  rig.blob.material.opacity = lerp(0.55, 0.06, lift / 0.6);
  rig.blob.scale.setScalar(lerp(1.0, 1.7, lift / 0.6));

  return plan;
}

export function setPose(rig, pose, durMs) {
  /* A beat that repeats what the fly is already doing must not rewind the
     animation — a fly lying on the floor should keep lying there, not climb
     back onto the stool to fall off it again. So resolve the request against
     where the fly actually is, and re-issuing the same pose only extends it. */
  const next = resolvePose(pose, rig.place);
  /* let a topple finish before settling into the sprawl, or the landing gets
     cut off halfway down */
  if (next === "down" && rig.pose === "fall" && rig.t < rig.dur) return;
  if (next === rig.pose) {
    rig.dur = Math.max(rig.dur, Math.max(1.4, (durMs || 3000) / 1000 * 0.92));
    return;
  }
  rig.prevPose = rig.pose;
  rig.pose = next;
  rig.t = 0;
  rig.dur = Math.max(1.4, (durMs || 3000) / 1000 * 0.92);
  if (next === "fall" || next === "down") rig.place = "floor";
  else if (next === "climb") rig.place = "stool";
  /* a kick on the springs at the cut gives every transition a snap */
  rig.s.squash.kick(next === "win" ? -3.5 : next === "fall" ? 2.5 : -1.2);
  rig.s.hatZ.kick((Math.random() - 0.5) * 6);
}
