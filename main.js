// MYCELIUM · atlas fungorum subterraneus
// Three.js без сборки. Сцена рендерится в текстуру, затем собственный пост-шейдер
// раскладывает кадр на три плашечные краски («печать») или рисует штриховкой («гербарий»).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a, b, t) => a + (b - a) * t;
/** плато 0→1→0: нарастает от a, держится до b */
const win = (f, a, b, e = 0.25) => smooth(a - e, a + e, f) * (1 - smooth(b - e, b + e, f));

document.documentElement.classList.add('js');
const mqReduce = matchMedia('(prefers-reduced-motion: reduce)');
let reduce = mqReduce.matches;
mqReduce.addEventListener?.('change', (e) => { reduce = e.matches; });

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(413);
const R = (a, b) => a + (b - a) * rnd();
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

// ---------------------------------------------------------------- палитра
const PAPER_HEX = '#ece2cb';
const INK = { pink: '#ff4fa3', green: '#1e5b3f', blue: '#2a5caa' };

// ================================================================ 3D
const ZC = 16;        // плоскость разреза почвы (z)
const DEPTH = 14;     // глубина среза
const XH = 80;        // полуширина блока

let gl = null;
try { gl = initScene(); } catch (err) {
  console.warn('WebGL недоступен:', err);
  $('.nogl')?.removeAttribute('hidden');
  $('#scene')?.classList.add('off');
}

function initScene() {
  const canvas = $('#scene');
  THREE.ColorManagement.enabled = false;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.localClippingEnabled = true;
  renderer.setClearColor(PAPER_HEX, 1);

  const scene = new THREE.Scene();
  const PAPER = new THREE.Color(PAPER_HEX);
  const SOIL = new THREE.Color('#6e5335');
  scene.fog = new THREE.Fog(PAPER.clone(), 60, 240);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 400);

  scene.add(new THREE.HemisphereLight('#fff4dc', '#6d5a3a', 2.2));
  const sun = new THREE.DirectionalLight('#fff0d0', 3.4);
  sun.position.set(30, 50, 26);
  scene.add(sun);
  const under = new THREE.DirectionalLight('#f3e3c4', 1.2); // мягкий «лабораторный» свет в срезе
  under.position.set(-10, -4, 30);
  scene.add(under);

  const clipZ = new THREE.Plane(V(0, 0, -1), ZC);

  // ---------------- фон: бумага / срез почвы
  const bgMat = new THREE.ShaderMaterial({
    depthTest: false, depthWrite: false,
    uniforms: {
      uInvProj: { value: new THREE.Matrix4() }, uCamMat: { value: new THREE.Matrix4() },
      uCamPos: { value: V() }, uPaper: { value: PAPER }, uXray: { value: 0 },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.9999, 1.0); }`,
    fragmentShader: `
      precision highp float;
      varying vec2 vUv; uniform mat4 uInvProj, uCamMat; uniform vec3 uCamPos, uPaper; uniform float uXray;
      float h(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7)))*43758.5453); }
      float n2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
        return mix(mix(h(i),h(i+vec2(1,0)),f.x), mix(h(i+vec2(0,1)),h(i+1.),f.x), f.y); }
      vec3 soil(vec2 p){ // p = (x, y) на плоскости среза
        float w = sin(p.x*.35)*.25 + n2(p*.6)*.35;
        vec3 litter = vec3(.36,.27,.16), humus = vec3(.40,.30,.19), mineral = vec3(.58,.47,.33), deep = vec3(.66,.58,.45);
        vec3 c = litter;
        c = mix(c, humus, smoothstep(-.45, -.8, p.y + w*.3));
        c = mix(c, mineral, smoothstep(-3.2, -4.6, p.y + w));
        c = mix(c, deep, smoothstep(-8.5, -10.5, p.y + w*1.5));
        float st = step(.965, h(floor(p*3.2)));             // камешки
        c = mix(c, vec3(.62,.56,.45), st*.8);
        c *= .9 + .2*n2(p*4.);
        return c;
      }
      void main(){
        vec4 v = uInvProj * vec4(vUv*2.-1., 1., 1.); v /= v.w;
        vec3 dir = normalize((uCamMat * vec4(v.xyz, 0.)).xyz);
        vec3 c = uCamPos; vec3 col = uPaper;
        bool inside = c.y < 0. && c.z < ${ZC.toFixed(1)} && c.y > -${DEPTH.toFixed(1)};
        if (inside) {
          col = mix(vec3(.40,.30,.19), vec3(.52,.41,.28), smoothstep(.6,-.6,dir.y));
          col *= .92 + .12*n2(dir.xy*40.+dir.z*13.);
        } else if (c.z > ${ZC.toFixed(1)} && dir.z < 0.) {
          float t = (${ZC.toFixed(1)} - c.z) / dir.z; vec3 p = c + t*dir;
          if (p.y < 0. && p.y > -${DEPTH.toFixed(1)} && abs(p.x) < ${XH.toFixed(1)}) col = soil(p.xy);
        }
        gl_FragColor = vec4(mix(col, uPaper, uXray), 1.);
      }`,
  });
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgMat);
  bg.frustumCulled = false; bg.renderOrder = -1000;
  scene.add(bg);

  // ---------------- земля (над срезом) и её изнанка
  const groundGeo = new THREE.PlaneGeometry(XH * 2, 96, 1, 1).rotateX(-Math.PI / 2).translate(0, 0, ZC - 48);
  const groundMat = new THREE.MeshLambertMaterial({ color: '#8c7b4c', transparent: true, side: THREE.FrontSide });
  const groundUnderMat = new THREE.MeshBasicMaterial({ color: '#2a1d12', transparent: true, side: THREE.BackSide });
  scene.add(new THREE.Mesh(groundGeo, groundMat), new THREE.Mesh(groundGeo, groundUnderMat));

  // подстилка: пятна листьев и хвои на поверхности
  {
    const n = 2600, pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
    const cc = [new THREE.Color('#6d5a31'), new THREE.Color('#a48a52'), new THREE.Color('#58623a')];
    for (let i = 0; i < n; i++) {
      pos.set([R(-XH, XH), 0.03, R(-80, ZC - 0.2)], i * 3);
      const c = cc[i % 3]; col.set([c.r, c.g, c.b], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    scene.add(new THREE.Points(g, new THREE.PointsMaterial({ size: 0.28, vertexColors: true })));
  }

  // ---------------- крупинки почвы (видны, когда камера под землёй)
  const grainMat = new THREE.PointsMaterial({ size: 0.07, color: '#9b8160', clippingPlanes: [clipZ] });
  {
    const n = 5200, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) pos.set([R(-34, 34), R(-DEPTH + 0.3, -0.2), R(-34, ZC)], i * 3);
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    scene.add(new THREE.Points(g, grainMat));
  }

  // ---------------- деревья
  const TREES = [
    { p: [0, 0, 0], h: 17, r: 0.95, type: 'fir', roots: 8, depth: 3 },   // 0 «материнское»
    { p: [-9, 0, 3], h: 11, r: 0.55, type: 'broad', roots: 5, depth: 2 }, // 1 образец микоризы
    { p: [8, 0, -4], h: 12, r: 0.6, type: 'fir', roots: 5, depth: 2 },    // 2 атакованное
    { p: [-4, 0, -10], h: 10, r: 0.5, type: 'broad', roots: 5, depth: 2 },
    { p: [5, 0, 8.5], h: 9, r: 0.45, type: 'broad', roots: 4, depth: 2 },
    { p: [13, 0, 5], h: 10, r: 0.5, type: 'fir', roots: 5, depth: 2 },    // 5 рубка
    { p: [15, 0, -9], h: 12, r: 0.6, type: 'fir', roots: 5, depth: 2 },   // 6 рубка
    { p: [9, 0, -15], h: 9, r: 0.45, type: 'broad', roots: 4, depth: 2 },  // 7 рубка
    { p: [-3.5, 0, 6], h: 3.2, r: 0.16, type: 'fir', roots: 3, depth: 1 }, // 8 сеянец
    { p: [-14, 0, -5], h: 12, r: 0.6, type: 'broad', roots: 5, depth: 2 },
    { p: [-11, 0, 11], h: 8, r: 0.4, type: 'fir', roots: 4, depth: 2 },
  ];
  const MOTHER = 0, ATTACKED = 2, CUT = new Set([5, 6, 7]);
  const trees = [];
  const barkCol = new THREE.Color('#6b4f36');
  const conCol = new THREE.Color('#3d6a3c');
  const broadCol = new THREE.Color('#6b9444');

  function taperTube(curve, seg, rad, radial, r0 = 1, r1 = 0.25) {
    const g = new THREE.TubeGeometry(curve, seg, rad, radial, false);
    const pos = g.attributes.position, c = V(), v = V();
    for (let i = 0; i <= seg; i++) {
      const u = i / seg; curve.getPointAt(u, c);
      const k = lerp(r0, r1, u);
      for (let j = 0; j <= radial; j++) {
        const idx = i * (radial + 1) + j;
        v.fromBufferAttribute(pos, idx).sub(c).multiplyScalar(k).add(c);
        pos.setXYZ(idx, v.x, v.y, v.z);
      }
    }
    return g;
  }

  function growRoot(start, dir, len, rad, depth, geos, tips) {
    const pts = [start.clone()]; const d = dir.clone(); let p = start.clone();
    const n = 6;
    for (let i = 0; i < n; i++) {
      d.add(V(R(-0.35, 0.35), R(-0.28, 0.12), R(-0.35, 0.35))).normalize();
      if (d.y > -0.08) d.y = -0.08;
      p = p.clone().addScaledVector(d, len / n);
      p.y = Math.min(p.y, -0.18); p.y = Math.max(p.y, -DEPTH + 1.5);
      pts.push(p);
    }
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    geos.push(taperTube(curve, 14, rad, 6, 1, depth > 0 ? 0.55 : 0.2));
    if (depth > 0) {
      const kids = 2 + (rnd() < 0.5 ? 1 : 0);
      for (let k = 0; k < kids; k++) {
        const u = R(0.35, 0.9);
        const o = curve.getPointAt(u); const t = curve.getTangentAt(u);
        const nd = t.clone().add(V(R(-0.9, 0.9), R(-0.5, 0.1), R(-0.9, 0.9))).normalize();
        growRoot(o, nd, len * R(0.5, 0.7), rad * lerp(1, 0.55, u) * 0.7, depth - 1, geos, tips);
      }
    } else tips.push(p.clone());
    if (depth > 0 && rnd() < 0.6) tips.push(p.clone());
  }

  TREES.forEach((T, i) => {
    const base = V(...T.p);
    const group = new THREE.Group(); group.position.copy(base);
    const trunkMat = new THREE.MeshLambertMaterial({ color: barkCol, transparent: true });
    const crownMat = new THREE.MeshLambertMaterial({ color: T.type === 'fir' ? conCol : broadCol, flatShading: true, transparent: true });
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(T.r * 0.55, T.r, T.h * 0.62, 9).translate(0, T.h * 0.31, 0), trunkMat);
    group.add(trunk);
    const crown = new THREE.Group();
    if (T.type === 'fir') {
      const tiers = 6;
      for (let k = 0; k < tiers; k++) {
        const t = k / tiers;
        const rr = lerp(T.h * 0.26, T.h * 0.06, t);
        const cone = new THREE.ConeGeometry(rr, T.h * 0.28, 9, 1);
        cone.translate(0, T.h * (0.3 + t * 0.6), 0);
        crown.add(new THREE.Mesh(cone, crownMat));
      }
    } else {
      for (let k = 0; k < 7; k++) {
        const s = T.h * R(0.14, 0.22);
        const g = new THREE.IcosahedronGeometry(s, 1);
        const pa = g.attributes.position;
        for (let j = 0; j < pa.count; j++) pa.setXYZ(j, pa.getX(j) * R(0.85, 1.12), pa.getY(j) * R(0.8, 1.05), pa.getZ(j) * R(0.85, 1.12));
        g.computeVertexNormals();
        const a = (k / 7) * Math.PI * 2;
        g.translate(Math.cos(a) * T.h * 0.14 * (k ? 1 : 0), T.h * R(0.62, 0.86), Math.sin(a) * T.h * 0.14 * (k ? 1 : 0));
        crown.add(new THREE.Mesh(g, crownMat));
      }
    }
    group.add(crown);
    scene.add(group);

    // пень — виден после рубки
    const stump = new THREE.Mesh(new THREE.CylinderGeometry(T.r * 1.02, T.r * 1.1, 0.7, 10).translate(0, 0.35, 0),
      new THREE.MeshLambertMaterial({ color: '#b89464' }));
    stump.position.copy(base); stump.visible = false; scene.add(stump);

    // корни
    const geos = [], tips = [];
    for (let k = 0; k < T.roots; k++) {
      const a = (k / T.roots) * Math.PI * 2 + R(-0.3, 0.3);
      const dir = V(Math.cos(a), -R(0.35, 0.7), Math.sin(a)).normalize();
      growRoot(base.clone().add(V(0, -0.1, 0)), dir, 2.4 + T.r * 5 + R(0, 1.5), T.r * 0.34, T.depth, geos, tips);
    }
    // стержневой корень
    growRoot(base.clone(), V(0, -1, 0), 2 + T.r * 4, T.r * 0.4, 1, geos, tips);
    const rootMat = new THREE.MeshLambertMaterial({ color: '#b48d62', clippingPlanes: [clipZ] });
    const roots = new THREE.Mesh(mergeGeometries(geos), rootMat);
    scene.add(roots);
    trees.push({ ...T, i, base, group, crown, crownMat, trunkMat, stump, rootMat, tips });
  });

  // ---------------- дальний лес (инстансы)
  const FAR = [];
  {
    const trunkG = new THREE.CylinderGeometry(0.25, 0.4, 6, 6).translate(0, 3, 0);
    const coneG = new THREE.ConeGeometry(2.4, 9, 7).translate(0, 8, 0);
    const n = 340;
    const trunkM = new THREE.InstancedMesh(trunkG, new THREE.MeshLambertMaterial({ color: barkCol, transparent: true }), n);
    const coneM = new THREE.InstancedMesh(coneG, new THREE.MeshLambertMaterial({ color: conCol, flatShading: true, transparent: true }), n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = V();
    let k = 0, guard = 0;
    while (k < n && guard++ < 6000) {
      const x = R(-XH + 3, XH - 3), z = R(-78, ZC - 3);
      if (Math.hypot(x, z) < 19) continue;
      const sc = R(0.7, 1.35);
      const inCut = x > 9 && x < 40 && z < 2 && z > -40;
      FAR.push({ x, z, sc, order: inCut ? rnd() : 2 });
      s.set(sc, sc * R(0.85, 1.2), sc);
      m.compose(V(x, 0, z), q, s);
      trunkM.setMatrixAt(k, m); coneM.setMatrixAt(k, m);
      k++;
    }
    trunkM.count = coneM.count = k;
    scene.add(trunkM, coneM);
    FAR.trunk = trunkM; FAR.cone = coneM;
  }

  // ---------------- образец микоризы: утолщённый корень дерева 1
  const specPts = [V(-9, -0.3, 3), V(-8.3, -1.6, 4.1), V(-7.1, -2.7, 5.4), V(-6.1, -3.4, 6.4), V(-5.2, -3.8, 7.3)];
  const specCurve = new THREE.CatmullRomCurve3(specPts, false, 'centripetal');
  const specMat = new THREE.MeshLambertMaterial({ color: '#c49b6a', clippingPlanes: [clipZ] });
  scene.add(new THREE.Mesh(taperTube(specCurve, 40, 0.42, 12, 1, 0.55), specMat));
  const tipPos = specCurve.getPointAt(1);
  const tipCap = new THREE.Mesh(new THREE.SphereGeometry(0.235, 12, 10), new THREE.MeshLambertMaterial({ color: '#e9dfc8' }));
  tipCap.position.copy(tipPos); scene.add(tipCap);
  // мантия — полупрозрачный чехол на последних 40 %
  {
    const sub = new THREE.CatmullRomCurve3(Array.from({ length: 12 }, (_, i) => specCurve.getPointAt(0.6 + 0.4 * (i / 11))), false, 'centripetal');
    const mantle = new THREE.Mesh(taperTube(sub, 24, 0.33, 14, 1, 0.8),
      new THREE.MeshLambertMaterial({ color: '#efe8d6', transparent: true, opacity: 0.55, depthWrite: false }));
    scene.add(mantle);
  }

  // ---------------- сеть гиф
  const H = { pos: [], dist: [], vuln: [], rnd: [], mom: [] };
  function addPolyline(pts, d0, d1, vuln, mom) {
    let L = 0; const acc = [0];
    for (let i = 1; i < pts.length; i++) { L += pts[i].distanceTo(pts[i - 1]); acc.push(L); }
    const r = rnd();
    for (let i = 1; i < pts.length; i++) {
      for (const j of [i - 1, i]) {
        const p = pts[j];
        H.pos.push(p.x, p.y, p.z);
        H.dist.push(Math.min(d0 + acc[j], d1 + (L - acc[j])));
        H.vuln.push(vuln); H.rnd.push(r); H.mom.push(mom);
      }
    }
    return { L, acc };
  }
  function wander(a, b, n, sag, amp) {
    const ph = [R(0, 6), R(0, 6), R(0, 6)], fr = [R(3, 7), R(3, 7), R(3, 7)];
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, e = Math.sin(Math.PI * t);
      const p = a.clone().lerp(b, t);
      p.x += Math.sin(t * fr[0] + ph[0]) * amp * e;
      p.y += -sag * e + Math.sin(t * fr[1] + ph[1]) * amp * 0.4 * e;
      p.z += Math.sin(t * fr[2] + ph[2]) * amp * e;
      p.y = Math.min(p.y, -0.15); p.y = Math.max(p.y, -DEPTH + 0.6);
      p.z = Math.min(p.z, ZC - 0.05);
      pts.push(p);
    }
    return pts;
  }
  function fuzz(o, count, len, d0, vuln, mom, spread = 1) {
    for (let k = 0; k < count; k++) {
      const pts = [o.clone()]; let p = o.clone();
      const d = V(R(-1, 1), R(-1, 0.5), R(-1, 1)).normalize();
      const n = 5, step = (len * R(0.4, 1)) / n;
      for (let i = 0; i < n; i++) {
        d.add(V(R(-0.6, 0.6), R(-0.6, 0.4), R(-0.6, 0.6)).multiplyScalar(spread)).normalize();
        p = p.clone().addScaledVector(d, step); p.y = Math.min(p.y, -0.1); p.z = Math.min(p.z, ZC - 0.05);
        pts.push(p);
      }
      addPolyline(pts, d0, d0 + 1e3, vuln, mom);
    }
  }

  // граф деревьев и кратчайшие расстояния от атакованного (для волны)
  const edges = [];
  for (let a = 0; a < trees.length; a++) for (let b = a + 1; b < trees.length; b++) {
    const d = trees[a].base.distanceTo(trees[b].base);
    if (d < 17.5) edges.push([a, b, d]);
  }
  const D = trees.map((t) => (t.i === ATTACKED ? 0 : Infinity));
  for (let it = 0; it < trees.length; it++) for (const [a, b, d] of edges) {
    const w = d * 1.25;
    if (D[a] + w < D[b]) D[b] = D[a] + w; if (D[b] + w < D[a]) D[a] = D[b] + w;
  }
  const pickTip = (t) => t.tips[Math.floor(rnd() * t.tips.length)];
  for (const [a, b] of edges) {
    const A = trees[a], B = trees[b];
    const mom = a === MOTHER || b === MOTHER ? 1 : 0;
    const vuln = CUT.has(a) || CUT.has(b) ? 1 : 0;
    const count = 2 + (mom ? 5 : 0) + Math.floor(rnd() * 3);
    for (let k = 0; k < count; k++) {
      const pa = pickTip(A), pb = pickTip(B);
      const pts = wander(pa, pb, 34, R(0.3, 2.2), R(0.4, 1.4));
      const { acc } = addPolyline(pts, D[a], D[b], vuln, mom);
      // боковые веточки
      for (let s = 0; s < 4; s++) {
        const j = 3 + Math.floor(rnd() * (pts.length - 6));
        const L = acc[acc.length - 1];
        fuzz(pts[j], 1, R(0.8, 2.2), Math.min(D[a] + acc[j], D[b] + L - acc[j]), vuln, mom);
      }
    }
  }
  trees.forEach((t) => t.tips.forEach((tp) => fuzz(tp, t.i === MOTHER ? 7 : 5, R(0.6, 1.6), D[t.i], CUT.has(t.i) ? 1 : 0, t.i === MOTHER ? 1 : 0)));

  // мантия-обмотка вокруг образца + гифы, уходящие из неё в почву
  const specFuzz = []; // пути для частиц обмена
  {
    const d0 = D[1];
    for (let s = 0; s < 26; s++) {
      const pts = []; const ph = R(0, Math.PI * 2); const turns = R(3, 6) * (rnd() < 0.5 ? -1 : 1);
      const u0 = R(0.55, 0.7);
      const N = V(), B = V(), T = V(), up = V(0, 1, 0);
      for (let i = 0; i <= 40; i++) {
        const u = lerp(u0, 1, i / 40);
        const c = specCurve.getPointAt(u); specCurve.getTangentAt(u, T);
        N.crossVectors(T, up).normalize(); B.crossVectors(T, N).normalize();
        const a = ph + turns * Math.PI * 2 * (i / 40);
        const rr = lerp(0.36, 0.26, (u - 0.6) / 0.4) * R(0.97, 1.05);
        pts.push(c.clone().addScaledVector(N, Math.cos(a) * rr).addScaledVector(B, Math.sin(a) * rr));
      }
      addPolyline(pts, d0, d0 + 1e3, 0, 0);
    }
    for (let s = 0; s < 70; s++) {
      const u = R(0.62, 1);
      const c = specCurve.getPointAt(u);
      const out = V(R(-1, 1), R(-1, 0.6), R(-1, 1)).normalize();
      const start = c.clone().addScaledVector(out, 0.34);
      const pts = [start]; let p = start.clone(); const d = out.clone();
      const len = R(1.2, 3.6);
      for (let i = 0; i < 12; i++) {
        d.add(V(R(-0.4, 0.4), R(-0.4, 0.3), R(-0.4, 0.4))).normalize();
        p = p.clone().addScaledVector(d, len / 12); p.y = Math.min(p.y, -0.2); p.z = Math.min(p.z, ZC - 0.1);
        pts.push(p);
      }
      addPolyline(pts, d0, d0 + 1e3, 0, 0);
      specFuzz.push({ u, pts });
    }
  }

  // мицелий под грибом и связь гриба с деревом 4
  const SHROOM = V(4.2, 0, 13.4);
  {
    const d0 = D[4];
    for (let s = 0; s < 70; s++) {
      const a = R(0, Math.PI * 2), r = R(1, 3.6);
      const from = V(SHROOM.x + Math.cos(a) * r, R(-2.8, -0.4), Math.min(ZC - 0.1, SHROOM.z + Math.sin(a) * r));
      addPolyline(wander(from, SHROOM.clone().add(V(0, -0.15, 0)), 10, -0.2, 0.3), d0 + 3, d0 + 3, 0, 0);
    }
    for (let k = 0; k < 5; k++) addPolyline(wander(pickTip(trees[4]), SHROOM.clone().add(V(R(-1, 1), -1.4, R(-1, 0.5))), 24, 0.6, 0.8), D[4], D[4] + 4, 0, 0);
  }
  // тяжи от валежины в почву
  const LOG = V(-8, 0.5, 12.2);
  for (let k = 0; k < 16; k++) {
    const a = V(LOG.x + R(-3, 3), -0.2, LOG.z + R(-0.3, 0.3));
    const b = V(LOG.x + R(-6, 6), R(-3, -1), Math.min(ZC - 0.1, LOG.z + R(-4, 3)));
    addPolyline(wander(a, b, 14, 0.4, 0.5), 60, 60, 0, 0);
  }

  const hyGeo = new THREE.BufferGeometry();
  hyGeo.setAttribute('position', new THREE.Float32BufferAttribute(H.pos, 3));
  hyGeo.setAttribute('aDist', new THREE.Float32BufferAttribute(H.dist, 1));
  hyGeo.setAttribute('aVuln', new THREE.Float32BufferAttribute(H.vuln, 1));
  hyGeo.setAttribute('aRnd', new THREE.Float32BufferAttribute(H.rnd, 1));
  hyGeo.setAttribute('aMom', new THREE.Float32BufferAttribute(H.mom, 1));
  const hyMat = new THREE.ShaderMaterial({
    uniforms: {
      uBase: { value: new THREE.Color('#f7f1e3') }, uPink: { value: new THREE.Color(INK.pink) },
      uDead: { value: new THREE.Color('#5a4633') }, uWave: { value: -10 }, uWaveOn: { value: 0 },
      uMom: { value: 0 }, uCut: { value: 0 }, uTime: { value: 0 },
      fogColor: { value: new THREE.Color() }, fogNear: { value: 1 }, fogFar: { value: 100 },
    },
    vertexShader: `
      attribute float aDist, aVuln, aRnd, aMom;
      uniform vec3 uBase, uPink, uDead; uniform float uWave, uWaveOn, uMom, uCut, uTime;
      varying vec3 vCol; varying float vDepth, vZ;
      void main(){
        vec4 wp = modelMatrix * vec4(position, 1.); vZ = wp.z;
        vec4 mv = viewMatrix * wp; gl_Position = projectionMatrix * mv; vDepth = -mv.z;
        vec3 c = uBase;
        c = mix(c, uPink, aMom * uMom * (.7 + .3*sin(uTime*2.2 - aDist*.5)));
        float w = uWaveOn * exp(-pow((aDist - uWave)/2.2, 2.));
        c = mix(c, uPink, clamp(w, 0., 1.));
        c = mix(c, uDead, aVuln * smoothstep(aRnd*.7, aRnd*.7 + .3, uCut));
        vCol = c;
      }`,
    fragmentShader: `
      uniform vec3 fogColor; uniform float fogNear, fogFar;
      varying vec3 vCol; varying float vDepth, vZ;
      void main(){
        if (vZ > ${ZC.toFixed(2)}) discard;
        gl_FragColor = vec4(mix(vCol, fogColor, smoothstep(fogNear, fogFar, vDepth)), 1.);
      }`,
  });
  const hyphae = new THREE.LineSegments(hyGeo, hyMat);
  hyphae.frustumCulled = false;
  scene.add(hyphae);

  // ---------------- частицы обмена
  const resample = (pts, n) => {
    const c = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
    return c.getSpacedPoints(n);
  };
  const trunkPts = [V(-9, 5, 3), V(-9, 2, 3), V(-9, 0, 3)];
  const sugarPaths = [], nutriPaths = [];
  specFuzz.slice(0, 40).forEach((sf) => {
    const alongRoot = Array.from({ length: 10 }, (_, i) => specCurve.getPointAt(sf.u * (i / 9)));
    const path = resample([...trunkPts, ...alongRoot, ...sf.pts], 120);
    sugarPaths.push(path);
    nutriPaths.push([...path].reverse());
  });
  const NP = 520;
  const partGeo = new THREE.BufferGeometry();
  const pPos = new Float32Array(NP * 3), pType = new Float32Array(NP), pInfo = [];
  for (let i = 0; i < NP; i++) {
    const type = i % 2; pType[i] = type;
    pInfo.push({ path: Math.floor(rnd() * sugarPaths.length), ph: rnd(), sp: R(0.05, 0.08) });
  }
  partGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  partGeo.setAttribute('aType', new THREE.BufferAttribute(pType, 1));
  const partMat = new THREE.ShaderMaterial({
    uniforms: { uSize: { value: 0 }, uPR: { value: 1 }, uA: { value: new THREE.Color(INK.pink) }, uB: { value: new THREE.Color('#2f6fd0') } },
    vertexShader: `attribute float aType; uniform float uSize, uPR; varying float vT; varying float vZ;
      void main(){ vT = aType; vec4 mv = modelViewMatrix * vec4(position,1.); vZ = (modelMatrix*vec4(position,1.)).z;
        gl_Position = projectionMatrix * mv; gl_PointSize = uSize * uPR * (6. / max(.5, -mv.z)); }`,
    fragmentShader: `uniform vec3 uA, uB; varying float vT; varying float vZ;
      void main(){ if (vZ > ${ZC.toFixed(2)}) discard; vec2 d = gl_PointCoord - .5; if (dot(d,d) > .25) discard;
        gl_FragColor = vec4(mix(uA, uB, vT), 1.); }`,
  });
  const particles = new THREE.Points(partGeo, partMat);
  particles.frustumCulled = false;
  scene.add(particles);

  // ---------------- насекомые у атакованного дерева
  const AT = trees[ATTACKED];
  const NI = 140;
  const insGeo = new THREE.BufferGeometry();
  {
    const p = new Float32Array(NI * 3), ph = new Float32Array(NI);
    for (let i = 0; i < NI; i++) {
      const v = V(R(-1, 1), R(-1, 1), R(-1, 1)).normalize().multiplyScalar(R(1.5, 3.8));
      p.set([AT.base.x + v.x, AT.h * 0.62 + v.y * 1.5, AT.base.z + v.z], i * 3); ph[i] = R(0, 100);
    }
    insGeo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    insGeo.setAttribute('aPh', new THREE.BufferAttribute(ph, 1));
  }
  const insMat = new THREE.ShaderMaterial({
    uniforms: { uT: { value: 0 }, uSize: { value: 0 }, uPR: { value: 1 } },
    vertexShader: `attribute float aPh; uniform float uT, uSize, uPR;
      void main(){ vec3 p = position + vec3(sin(uT*3.1+aPh), sin(uT*2.3+aPh*1.7)*.6, cos(uT*2.7+aPh))*.45;
        vec4 mv = modelViewMatrix*vec4(p,1.); gl_Position = projectionMatrix*mv; gl_PointSize = uSize*uPR*(14./max(1.,-mv.z)); }`,
    fragmentShader: `void main(){ vec2 d = gl_PointCoord-.5; if (dot(d,d)>.25) discard; gl_FragColor = vec4(.16,.12,.09,1.); }`,
  });
  const insects = new THREE.Points(insGeo, insMat); insects.frustumCulled = false; scene.add(insects);

  // ---------------- мухомор
  const shroom = new THREE.Group(); shroom.position.copy(SHROOM); scene.add(shroom);
  const shroomInner = new THREE.Group(); shroom.add(shroomInner);
  {
    const white = new THREE.MeshLambertMaterial({ color: '#f3eee2' });
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.19, 1.25, 12).translate(0, 0.62, 0), white);
    const volva = new THREE.Mesh(new THREE.SphereGeometry(0.24, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.7, 1), white);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.26, 0.12, 14, 1, true).translate(0, 1.0, 0), new THREE.MeshLambertMaterial({ color: '#efe8d8', side: THREE.DoubleSide }));
    const prof = [];
    for (let i = 0; i <= 14; i++) { const t = i / 14; prof.push(new THREE.Vector2(Math.sin(t * Math.PI * 0.5) * 0.82, Math.cos(t * Math.PI * 0.5) * 0.46 - (t > 0.9 ? (t - 0.9) * 0.8 : 0))); }
    const cap = new THREE.Mesh(new THREE.LatheGeometry(prof, 28).translate(0, 1.2, 0), new THREE.MeshLambertMaterial({ color: '#e8467f', side: THREE.DoubleSide }));
    const gills = new THREE.Mesh(new THREE.CircleGeometry(0.8, 28).rotateX(Math.PI / 2).translate(0, 1.19, 0), new THREE.MeshLambertMaterial({ color: '#f4efe2' }));
    shroomInner.add(stem, volva, ring, cap, gills);
    const wartG = new THREE.SphereGeometry(0.045, 6, 4);
    for (let k = 0; k < 34; k++) {
      const t = R(0.05, 0.85), a = R(0, Math.PI * 2);
      const w = new THREE.Mesh(wartG, white);
      w.position.set(Math.cos(a) * Math.sin(t * Math.PI * 0.5) * 0.82, 1.2 + Math.cos(t * Math.PI * 0.5) * 0.46 + 0.02, Math.sin(a) * Math.sin(t * Math.PI * 0.5) * 0.82);
      shroomInner.add(w);
    }
  }
  // споры
  const NS = 600;
  const sporeGeo = new THREE.BufferGeometry();
  {
    const p = new Float32Array(NS * 3), sd = new Float32Array(NS);
    for (let i = 0; i < NS; i++) { const a = R(0, Math.PI * 2), r = R(0.15, 0.75); p.set([Math.cos(a) * r, 1.15, Math.sin(a) * r], i * 3); sd[i] = rnd(); }
    sporeGeo.setAttribute('position', new THREE.BufferAttribute(p, 3));
    sporeGeo.setAttribute('aSeed', new THREE.BufferAttribute(sd, 1));
  }
  const sporeMat = new THREE.ShaderMaterial({
    uniforms: { uT: { value: 0 }, uSize: { value: 0 }, uPR: { value: 1 } },
    vertexShader: `attribute float aSeed; uniform float uT, uSize, uPR; varying float vA;
      void main(){ float t = fract(uT*.07 + aSeed);
        vec3 p = position;
        p.y -= min(t, .12) * 2.2;                             // падение из-под шляпки
        vec2 out2 = normalize(p.xz + 1e-3);
        p.xz += out2 * smoothstep(.08, .3, t) * 1.2;          // выносит наружу
        p.y += smoothstep(.1, 1., t) * 3.2;                   // конвективный подъём
        p.x += t * t * 3.5 + sin(uT + aSeed*40.) * .25 * t;  // ветер
        vA = smoothstep(0., .08, t) * (1. - smoothstep(.75, 1., t));
        vec4 mv = modelViewMatrix*vec4(p,1.); gl_Position = projectionMatrix*mv;
        gl_PointSize = uSize*uPR*(4./max(.5,-mv.z)) * vA; }`,
    fragmentShader: `void main(){ vec2 d = gl_PointCoord-.5; if (dot(d,d)>.25) discard; gl_FragColor = vec4(.33,.43,.72,1.); }`,
  });
  const spores = new THREE.Points(sporeGeo, sporeMat); spores.frustumCulled = false; shroom.add(spores);

  // ---------------- валежина с белой гнилью
  const logMat = new THREE.ShaderMaterial({
    uniforms: { uDecay: { value: 0 }, uLight: { value: V(0.5, 0.8, 0.4).normalize() } },
    vertexShader: `varying vec3 vP, vN; varying float vAx;
      void main(){ vP = position; vAx = position.y; vN = normalize(normalMatrix*normal);
        gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.); }`,
    fragmentShader: `
      uniform float uDecay; uniform vec3 uLight; varying vec3 vP, vN; varying float vAx;
      float h(vec3 p){ return fract(sin(dot(p, vec3(127.1,311.7,74.7)))*43758.5453); }
      float n3(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
        return mix(mix(mix(h(i),h(i+vec3(1,0,0)),f.x),mix(h(i+vec3(0,1,0)),h(i+vec3(1,1,0)),f.x),f.y),
                   mix(mix(h(i+vec3(0,0,1)),h(i+vec3(1,0,1)),f.x),mix(h(i+vec3(0,1,1)),h(i+1.),f.x),f.y),f.z); }
      void main(){
        float n = n3(vP*1.6)*.6 + n3(vP*4.)*.4;
        float k = uDecay*1.55 - (.5 - vAx/7.) - (n - .5)*.7;   // фронт гнили идёт с одного конца
        if (k > .55) discard;                                  // съедено
        vec3 bark = vec3(.42,.30,.19) * (.8 + .35*n3(vec3(vP.x*3., vAx*.4, vP.z*3.)));
        vec3 rot = vec3(.93,.89,.80) * (.92 + .08*n);
        vec3 c = k > 0. ? rot : bark;
        c = mix(c, vec3(.1,.08,.06), (1. - smoothstep(.0, .035, abs(k))) * step(.0, uDecay - .01)); // линии спалтинга
        float l = .55 + .55*max(dot(normalize(vN), uLight), 0.);
        gl_FragColor = vec4(c*l, 1.);
      }`,
    side: THREE.DoubleSide,
  });
  const logMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.62, 7, 20, 30, false), logMat);
  logMesh.rotation.z = Math.PI / 2; logMesh.rotation.y = 0.12; logMesh.position.copy(LOG);
  scene.add(logMesh);
  const brackets = [];
  {
    const bm = new THREE.MeshLambertMaterial({ color: '#c8a26a' });
    const edge = new THREE.MeshLambertMaterial({ color: '#f1e6cc' });
    for (let k = 0; k < 6; k++) {
      const g = new THREE.Group();
      const s = R(0.28, 0.5);
      const shelf = new THREE.Mesh(new THREE.SphereGeometry(s, 16, 8, 0, Math.PI).scale(1, 0.32, 1), bm);
      const lip = new THREE.Mesh(new THREE.TorusGeometry(s * 0.98, 0.03, 4, 16, Math.PI), edge);
      lip.rotation.x = Math.PI / 2;
      g.add(shelf, lip);
      g.position.set(LOG.x + R(-2.8, 0.6), LOG.y + R(-0.1, 0.35), LOG.z + 0.58);
      g.rotation.y = Math.PI; g.scale.setScalar(0.001);
      scene.add(g); brackets.push({ g, at: R(0.15, 0.55) });
    }
  }

  // ---------------- постобработка
  const pr0 = () => Math.min(window.devicePixelRatio || 1, 2);
  const rt = new THREE.WebGLRenderTarget(4, 4, { depthBuffer: true });
  rt.depthTexture = new THREE.DepthTexture(4, 4);
  rt.texture.minFilter = rt.texture.magFilter = THREE.LinearFilter;

  const paperV = V(PAPER.r, PAPER.g, PAPER.b);
  const inkV = (hex) => { const c = new THREE.Color(hex); return V(c.r, c.g, c.b); };
  const inkD = (hex) => { const c = new THREE.Color(hex);
    return [c.r / PAPER.r, c.g / PAPER.g, c.b / PAPER.b].map((t) => -Math.log(Math.min(1, Math.max(0.04, t)))); };
  const dP = inkD(INK.pink), dG = inkD(INK.green), dB = inkD(INK.blue);
  const sepM = new THREE.Matrix3().set(dP[0], dG[0], dB[0], dP[1], dG[1], dB[1], dP[2], dG[2], dB[2]).invert();

  const postMat = new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: rt.texture }, tDepth: { value: rt.depthTexture },
      uRes: { value: new THREE.Vector2(1, 1) }, uPR: { value: 1 }, uTime: { value: 0 }, uMode: { value: 0 },
      uCell: { value: 5 }, uPaper: { value: paperV },
      uInk0: { value: inkV(INK.pink) }, uInk1: { value: inkV(INK.green) }, uInk2: { value: inkV(INK.blue) },
      uSep: { value: sepM },
      uOff0: { value: new THREE.Vector2(1.6, -1.1) }, uOff1: { value: new THREE.Vector2(0, 0) }, uOff2: { value: new THREE.Vector2(-1.3, 1.4) },
      uLens: { value: new THREE.Vector3(0, 0, 0) }, uNear: { value: 0.1 }, uFar: { value: 400 },
    },
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }`,
    fragmentShader: `
      precision highp float;
      uniform sampler2D tScene, tDepth;
      uniform vec2 uRes, uOff0, uOff1, uOff2; uniform float uPR, uTime, uMode, uCell, uNear, uFar;
      uniform vec3 uPaper, uInk0, uInk1, uInk2, uLens; uniform mat3 uSep;
      float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x*p.y); }
      float vn(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
        return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+1.),f.x), f.y); }
      vec3 sceneAt(vec2 px){ return texture2D(tScene, clamp(px/uRes, vec2(0.), vec2(1.))).rgb; }
      vec3 sep(vec3 c){ vec3 L = max(-log(max(c, vec3(1e-3))/uPaper), vec3(0.)); return clamp(uSep*L, 0., 1.); }
      float screen(vec2 px, float d, float ang){
        float s = sin(ang), c = cos(ang);
        vec2 p = mat2(c, -s, s, c) * px / (uCell*uPR);
        float dist = length(fract(p) - .5);
        float r = sqrt(d) * .75, aa = .9/(uCell);
        return 1. - smoothstep(r - aa, r + aa, dist);
      }
      float lum(vec3 c){ return dot(c, vec3(.299,.587,.114)); }
      // плотности красок: цветоделение + тени уходят в синий растр + ограничение суммы краски
      vec3 dens(vec3 c){
        vec3 d = sep(c);
        float sh = smoothstep(.5, .98, 1. - lum(c)/lum(uPaper));
        d.x *= .85 * (1. - sh*.45);
        d.y *= 1. - sh*.2;
        d.z = max(d.z, sh*.62);
        float tac = d.x + d.y + d.z;
        return tac > 1.45 ? d * (1.45/tac) : d;
      }
      vec3 riso(vec2 px){
        vec2 o0 = uOff0*uPR, o1 = uOff1*uPR, o2 = uOff2*uPR;
        float d0 = dens(sceneAt(px + o0)).x, d1 = dens(sceneAt(px + o1)).y, d2 = dens(sceneAt(px + o2)).z;
        float blot = vn(px/(160.*uPR) + 3.), grain = vn(px*.8/uPR);
        float c0 = max(screen(px + o0, d0*(.9 + .2*blot), .2618), smoothstep(.82, .96, d0));
        float c1 = max(screen(px + o1, d1, 1.309), smoothstep(.82, .96, d1));
        float c2 = max(screen(px + o2, d2*(.9 + .2*(1.-blot)), .7854), smoothstep(.82, .96, d2));
        vec2 q = floor(px/uPR);
        c0 *= step(.05, hash(q + 1.7)) * (.84 + .16*grain);
        c1 *= step(.05, hash(q + 5.3)) * (.86 + .14*grain);
        c2 *= step(.05, hash(q + 9.1)) * (.84 + .16*grain);
        vec3 col = uPaper;
        col *= mix(vec3(1.), uInk0/uPaper, c0*.96);
        col *= mix(vec3(1.), uInk1/uPaper, c1*.96);
        col *= mix(vec3(1.), uInk2/uPaper, c2*.92);
        return min(col, vec3(1.));
      }
      float linD(vec2 px){ float z = texture2D(tDepth, clamp(px/uRes, vec2(0.), vec2(1.))).x;
        return (2.*uNear*uFar) / (uFar + uNear - (z*2.-1.)*(uFar - uNear)); }
      float hatch(vec2 p, float ang, float sp, float w){
        float v = dot(p, vec2(cos(ang), sin(ang))) / sp;
        float f = abs(fract(v) - .5) * sp;
        return 1. - smoothstep(w*.5, w*.5 + uPR, f);
      }
      vec3 herb(vec2 px){
        vec2 wob = vec2(vn(px/(40.*uPR)), vn(px/(40.*uPR) + 11.)) - .5;
        vec2 q = px + wob*7.*uPR;
        vec3 c = sceneAt(px);
        float D = clamp(1. - lum(c)/lum(uPaper), 0., 1.) * .82;
        float s = 5.5*uPR, h = 0.;
        h = max(h, hatch(q, .785, s, mix(.7, 1.7, D)*uPR) * smoothstep(.08, .16, D));
        h = max(h, hatch(q, -.785, s, 1.1*uPR) * smoothstep(.34, .42, D));
        h = max(h, hatch(q, .06, s*.85, 1.1*uPR) * smoothstep(.56, .64, D));
        h = max(h, hatch(q + 2., 1.63, s*.7, 1.3*uPR) * smoothstep(.76, .84, D));
        h *= step(.14, vn(q/(2.4*uPR)));   // перо иногда «пропускает»
        vec2 e = vec2(1.2*uPR, 0.);
        float l00 = lum(sceneAt(px - e.xx)), l10 = lum(sceneAt(px - e.yx)), l20 = lum(sceneAt(px + vec2(e.x, -e.x)));
        float l01 = lum(sceneAt(px - e.xy)), l21 = lum(sceneAt(px + e.xy));
        float l02 = lum(sceneAt(px + vec2(-e.x, e.x))), l12 = lum(sceneAt(px + e.yx)), l22 = lum(sceneAt(px + e.xx));
        float gx = -l00 - 2.*l01 - l02 + l20 + 2.*l21 + l22;
        float gy = -l00 - 2.*l10 - l20 + l02 + 2.*l12 + l22;
        float edgeL = smoothstep(.22, .45, length(vec2(gx, gy)));
        float dc = linD(px);
        float dd = abs(linD(px + e.xy) - dc) + abs(linD(px + e.yx) - dc);
        float edgeD = smoothstep(.04, .09, dd / max(dc, .5));
        float ink = max(h, max(edgeL, edgeD) * step(.2, vn(q/(3.*uPR) + 40.)));
        vec3 d = sep(c);
        vec3 wash = uPaper * mix(vec3(1.), uInk0/uPaper, d.x*.3) * mix(vec3(1.), uInk2/uPaper, d.z*.22) * mix(vec3(1.), uInk1/uPaper, d.y*.1);
        return mix(min(wash, vec3(1.)), vec3(.12,.17,.12), clamp(ink, 0., 1.)*.92);
      }
      void main(){
        vec2 px = gl_FragCoord.xy;
        vec3 outc = uMode < .01 ? riso(px) : (uMode > .99 ? herb(px) : mix(riso(px), herb(px), uMode));
        outc *= .965 + .05*vn(px*.45/uPR);                   // волокна бумаги
        if (uLens.z > 0.) {
          float d = distance(px, uLens.xy);
          if (d < uLens.z) outc = sceneAt(uLens.xy + (px - uLens.xy)/1.6);
          float ring = smoothstep(uLens.z + 3.*uPR, uLens.z + 1.*uPR, d) * smoothstep(uLens.z - 1.*uPR, uLens.z, d);
          outc = mix(outc, vec3(.11,.2,.15), ring);
          outc *= 1. - .12*smoothstep(uLens.z + 12.*uPR, uLens.z + 3.*uPR, d) * step(uLens.z, d);
        }
        gl_FragColor = vec4(outc, 1.);
      }`,
  });
  const postScene = new THREE.Scene();
  const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const postQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), postMat);
  postQuad.frustumCulled = false; postScene.add(postQuad);

  // ---------------- камера: ключевые кадры по главам
  const KEYS = [
    { f: 0.0, p: [0, 64, 90], l: [0, 0, -8] },
    { f: 0.55, p: [7, 26, 42], l: [0, 6, 0] },
    { f: 0.9, p: [3, 7, 18], l: [-2, 3, 2] },
    { f: 1.14, p: [-1.4, -1.3, 13.2], l: [-5, -3, 6] },
    { f: 1.5, p: [-3.1, -2.9, 10.1], l: [-5.5, -3.6, 6.9] },
    { f: 2.5, p: [-1.6, -1.5, 13.2], l: [-7, -2.8, 5] },
    { f: 3.5, p: [-1, -4.2, 30], l: [0, -4.4, -2] },
    { f: 4.5, p: [3, 3.5, 38], l: [2, -1.5, -2] },
    { f: 5.5, p: [7.6, 2.4, 21.5], l: [4.2, 0.9, 13.4] },
    { f: 6.5, p: [-5.0, 2.3, 17.6], l: [-8, 0.5, 12.2] },
    { f: 7.5, p: [20, 14, 40], l: [2, -1, -2] },
    { f: 8.5, p: [0, 50, 6], l: [0, 0, -1] },
    { f: 9.0, p: [0, 54, 5], l: [0, 0, -1] },
  ];
  const posCurve = new THREE.CatmullRomCurve3(KEYS.map((k) => V(...k.p)), false, 'centripetal');
  const lookCurve = new THREE.CatmullRomCurve3(KEYS.map((k) => V(...k.l)), false, 'centripetal');
  function curveParam(f) {
    const n = KEYS.length - 1;
    if (f <= KEYS[0].f) return 0;
    for (let i = 0; i < n; i++) {
      const a = KEYS[i].f, b = KEYS[i + 1].f;
      if (f <= b) { const t = (f - a) / (b - a); return (i + t * t * (3 - 2 * t)) / n; }
    }
    return 1;
  }

  // ---------------- рукописные подписи на сцене
  const LABELS = [
    { t: 'кончик корня', p: V(-4.9, -4.25, 7.4), a: 1.05, b: 1.95 },
    { t: 'мантия гриба', p: V(-6.2, -2.75, 6.1), a: 1.05, b: 2.9 },
    { t: 'гифы уходят в почву', p: V(-3.4, -4.6, 7.8), a: 1.1, b: 1.95 },
    { t: 'сахара вниз', p: V(-8.2, -1.0, 4.0), a: 2.05, b: 2.95, c: 'k-pink' },
    { t: 'фосфор и азот — к дереву', p: V(-4.4, -4.9, 8.6), a: 2.05, b: 2.95, c: 'k-blue' },
    { t: '«материнское» дерево?', p: V(0, -1.4, 0.4), a: 3.1, b: 3.95 },
    { t: 'сеянец', p: V(-3.5, -0.8, 6), a: 3.1, b: 3.95 },
    { t: 'атака насекомых', p: V(8, 13.5, -4), a: 4.1, b: 4.95 },
    { t: 'сигнал? гипотеза', p: V(3, -3.4, 2), a: 4.1, b: 4.95, c: 'k-pink' },
    { t: 'Amanita muscaria', p: V(4.2, 2.3, 13.4), a: 5.15, b: 5.95 },
    { t: 'споры', p: V(6.2, 2.4, 13.4), a: 5.3, b: 5.95 },
    { t: 'белая гниль', p: V(-6.0, 1.45, 12.2), a: 6.2, b: 6.95 },
    { t: 'трутовики', p: V(-9.6, 1.45, 12.8), a: 6.35, b: 6.95 },
    { t: 'сплошная рубка', p: V(13, 7, -6), a: 7.25, b: 7.95 },
    { t: 'связи гаснут', p: V(11, -3.5, 6), a: 7.3, b: 7.95 },
  ];
  const labRoot = $('#labels');
  LABELS.forEach((L) => { const el = document.createElement('span'); el.className = 'lab' + (L.c ? ' ' + L.c : ''); el.textContent = L.t; labRoot.appendChild(el); L.el = el; });

  // ---------------- размеры
  let W = 1, Hh = 1, PR = 1;
  function resize() {
    W = window.innerWidth; Hh = window.innerHeight; PR = pr0();
    renderer.setPixelRatio(PR);
    renderer.setSize(W, Hh, false);
    const w = Math.floor(W * PR), h = Math.floor(Hh * PR);
    rt.setSize(w, h);
    postMat.uniforms.uRes.value.set(w, h);
    postMat.uniforms.uPR.value = PR;
    postMat.uniforms.uCell.value = W < 720 ? 4.2 : 5;
    partMat.uniforms.uPR.value = insMat.uniforms.uPR.value = sporeMat.uniforms.uPR.value = PR;
    camera.aspect = W / Hh;
    camera.fov = W < 720 ? 62 : 50;
    camera.updateProjectionMatrix();
  }
  resize();

  // ---------------- кадр
  const tmp = V(), tmpL = V(), m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sv = V();
  let lastCut = -1;
  const inkPink = new THREE.Color(INK.pink);
  const baseWhite = new THREE.Color('#f7f1e3'), inkDark = new THREE.Color('#1e5b3f');

  function update(f, time, fCam = f, viewOff = 0) {
    if (W >= 900 && Math.abs(viewOff) > 0.5) camera.setViewOffset(W, Hh, viewOff, 0, W, Hh);
    else if (camera.view && camera.view.enabled) camera.clearViewOffset();
    // камера
    const u = curveParam(fCam);
    posCurve.getPoint(u, tmp); lookCurve.getPoint(u, tmpL);
    if (!reduce) { tmp.x += Math.sin(time * 0.21) * 0.12; tmp.y += Math.sin(time * 0.17) * 0.08; }
    camera.position.copy(tmp); camera.lookAt(tmpL);
    camera.updateMatrixWorld();

    const insideSoil = tmp.y < 0 && tmp.z < ZC;
    const final = smooth(8.0, 8.6, f);
    // туман: под землёй — плотный цвета почвы
    if (insideSoil) { scene.fog.color.copy(SOIL); scene.fog.near = 3; scene.fog.far = 26; }
    else { scene.fog.color.copy(PAPER); scene.fog.near = 70; scene.fog.far = 260; }
    hyMat.uniforms.fogColor.value.copy(scene.fog.color);
    hyMat.uniforms.fogNear.value = scene.fog.near; hyMat.uniforms.fogFar.value = scene.fog.far;

    bgMat.uniforms.uInvProj.value.copy(camera.projectionMatrixInverse);
    bgMat.uniforms.uCamMat.value.copy(camera.matrixWorld);
    bgMat.uniforms.uCamPos.value.copy(tmp);
    bgMat.uniforms.uXray.value = final;

    // обмен
    const flow = win(f, 1.95, 3.05, 0.2);
    partMat.uniforms.uSize.value = flow * 4.5;
    particles.visible = flow > 0.001;
    if (particles.visible) {
      const tt = reduce ? (f - 2) * 3 : time;
      for (let i = 0; i < NP; i++) {
        const P = pInfo[i];
        const path = pType[i] ? nutriPaths[P.path] : sugarPaths[P.path];
        const x = ((P.ph + tt * P.sp) % 1) * (path.length - 1);
        const k = Math.floor(x), fr = x - k;
        const a = path[k], b = path[Math.min(k + 1, path.length - 1)];
        pPos[i * 3] = lerp(a.x, b.x, fr); pPos[i * 3 + 1] = lerp(a.y, b.y, fr); pPos[i * 3 + 2] = lerp(a.z, b.z, fr);
      }
      partGeo.attributes.position.needsUpdate = true;
    }

    // сеть, «материнское дерево», волна
    hyMat.uniforms.uTime.value = time;
    hyMat.uniforms.uMom.value = Math.max(win(f, 3.0, 3.95, 0.2), smooth(8.1, 8.6, f));
    const waveOn = win(f, 4.0, 4.98, 0.18);
    hyMat.uniforms.uWaveOn.value = waveOn;
    hyMat.uniforms.uWave.value = reduce ? (f - 4) * 50 : ((time * 7) % 52) - 4;
    insMat.uniforms.uT.value = time;
    insMat.uniforms.uSize.value = waveOn * 5;
    insects.visible = waveOn > 0.001;
    AT.crownMat.color.copy(conCol).lerp(new THREE.Color('#9a7b3e'), waveOn * 0.8);

    // гриб и споры
    const grow = smooth(4.95, 5.45, f);
    const e = 1 - Math.pow(1 - grow, 3);
    shroomInner.scale.set(0.3 + 0.7 * e, Math.max(0.001, e), 0.3 + 0.7 * e);
    shroom.visible = grow > 0.001;
    shroom.scale.setScalar(1.25);
    sporeMat.uniforms.uT.value = reduce ? f * 8 : time;
    sporeMat.uniforms.uSize.value = win(f, 5.3, 6.1, 0.2) * 4;

    // разложение
    const decay = smooth(5.95, 6.85, f);
    logMat.uniforms.uDecay.value = decay;
    brackets.forEach((b) => b.g.scale.setScalar(Math.max(0.001, smooth(b.at, b.at + 0.25, decay))));

    // рубка
    const cut = smooth(7.05, 7.75, f);
    hyMat.uniforms.uCut.value = cut;
    trees.forEach((t) => {
      if (!CUT.has(t.i)) return;
      const k = clamp01((cut - (t.i - 5) * 0.12) / 0.6);
      t.group.rotation.z = -Math.pow(k, 2.2) * Math.PI * 0.5;
      t.group.visible = k < 0.98;
      t.stump.visible = k > 0.02;
      t.rootMat.color.set('#b48d62').lerp(new THREE.Color('#5f4b36'), k);
    });
    const cutQ = Math.round(cut * 40) / 40;
    if (cutQ !== lastCut) {
      lastCut = cutQ;
      FAR.forEach((F, i) => {
        const gone = F.order < cutQ;
        sv.set(gone ? 0.001 : F.sc, gone ? 0.001 : F.sc, gone ? 0.001 : F.sc);
        m4.compose(V(F.x, 0, F.z), q, sv);
        FAR.trunk.setMatrixAt(i, m4); FAR.cone.setMatrixAt(i, m4);
      });
      FAR.trunk.instanceMatrix.needsUpdate = FAR.cone.instanceMatrix.needsUpdate = true;
    }

    // финал: «рентген» сверху
    groundMat.opacity = groundUnderMat.opacity = 1 - final * 0.93;
    grainMat.visible = final < 0.5;
    trees.forEach((t) => { t.crownMat.opacity = 1 - final * 0.8; t.trunkMat.opacity = 1 - final * 0.6; });
    FAR.cone.material.opacity = 1 - final * 0.75; FAR.trunk.material.opacity = 1 - final * 0.6;
    hyMat.uniforms.uBase.value.copy(baseWhite).lerp(inkDark, final);
    hyMat.uniforms.uPink.value.copy(inkPink);

    // подписи
    LABELS.forEach((L) => {
      const on = f > L.a && f < L.b;
      if (on) {
        tmp.copy(L.p).project(camera);
        const onScreen = tmp.z < 1 && Math.abs(tmp.x) < 0.95 && Math.abs(tmp.y) < 0.92;
        L.el.style.transform = `translate(${((tmp.x + 1) / 2) * W}px, ${((1 - tmp.y) / 2) * Hh - 22}px) translate(-50%,-50%) rotate(-2deg)`;
        L.el.classList.toggle('on', onScreen);
      } else L.el.classList.remove('on');
    });
  }

  function render(mode, lens) {
    postMat.uniforms.uMode.value = mode;
    postMat.uniforms.uLens.value.set(lens.x * PR, (Hh - lens.y) * PR, lens.on ? lens.r * PR : 0);
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCam);
  }

  return { resize, update, render, canvas };
}

// ================================================================ скролл → глава
const chapters = $$('.chapter');
const appendices = $('#appendices');
let fTarget = 0, fCur = 0, tops = [];
function measure() {
  tops = chapters.map((c) => { const r = c.getBoundingClientRect(); return { top: r.top + scrollY, h: r.height }; });
}
function computeF() {
  const mid = scrollY + innerHeight * 0.5;
  let f = 0;
  for (let i = 0; i < tops.length; i++) {
    const { top, h } = tops[i];
    if (mid >= top) f = i + clamp01((mid - top) / h);
  }
  return f;
}

// ---------------- режимы и лупа
let modeTarget = 0, modeCur = 0;
try { if (localStorage.getItem('myc-mode') === 'herb') { modeTarget = modeCur = 1; $('input[value="herb"]').checked = true; } } catch (e) { /* хранилище недоступно */ }
$$('input[name="mode"]').forEach((r) => r.addEventListener('change', () => {
  modeTarget = r.value === 'herb' ? 1 : 0;
  try { localStorage.setItem('myc-mode', r.value); } catch (e) { /* ничего */ }
}));

const lens = { x: -999, y: -999, r: 90, on: false };
const lensTag = $('#lens-tag');
const blocksLens = (el) => el && el.closest && el.closest('.card, .cover__sheet, .modebar, .appendices, a, button');
function setLens(x, y, on) {
  lens.x = x; lens.y = y; lens.on = on && !sceneHidden;
  lensTag.classList.toggle('on', lens.on);
  if (lens.on) lensTag.style.transform = `translate(${x}px, ${y + lens.r + 8}px) translate(-50%,0) rotate(-3deg)`;
}
addEventListener('pointermove', (e) => {
  if (e.pointerType === 'touch' && !touchLens) return;
  setLens(e.clientX, e.clientY, !blocksLens(e.target));
}, { passive: true });
document.documentElement.addEventListener('mouseleave', () => setLens(-999, -999, false));
addEventListener('blur', () => setLens(-999, -999, false));
let touchLens = false;
addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  touchLens = !blocksLens(e.target);
  if (touchLens) setLens(e.clientX, e.clientY - 70, true);
}, { passive: true });
addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') { touchLens = false; setLens(-999, -999, false); } }, { passive: true });
addEventListener('pointercancel', () => { touchLens = false; setLens(-999, -999, false); }, { passive: true });

// ---------------- прогресс-гифа
const prog = $('#progress');
const progGrow = $('.grow', prog), progTrack = $('.track', prog), twigs = $('.twigs', prog);
let progLen = 1, twigList = [];
function buildProgress() {
  const h = innerHeight, x0 = innerWidth < 720 ? 6 : 9;
  let d = `M${x0} 0`;
  for (let y = 12; y <= h; y += 12) d += ` L${(x0 + Math.sin(y * 0.021) * 3 + Math.sin(y * 0.063 + 1) * 1.4).toFixed(1)} ${y}`;
  progGrow.setAttribute('d', d); progTrack.setAttribute('d', d);
  progLen = progGrow.getTotalLength();
  progGrow.style.strokeDasharray = `${progLen}`;
  twigs.innerHTML = '';
  const doc = document.documentElement.scrollHeight - innerHeight;
  twigList = [...chapters, ...$$('.sheet')].map((el, i) => {
    const at = clamp01((el.getBoundingClientRect().top + scrollY - innerHeight * 0.5) / doc);
    const y = at * h, s = i % 2 ? 1 : -1;
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const x = x0 + Math.sin(y * 0.021) * 3;
    p.setAttribute('d', `M${x.toFixed(1)} ${y.toFixed(1)} q ${6 * s + 6} -4 ${10 + 4 * s} -12 m -${5 + 2 * s} 6 q 4 -1 6 -6`);
    twigs.appendChild(p);
    const L = p.getTotalLength(); p.style.strokeDasharray = `${L}`; p.style.strokeDashoffset = `${L}`;
    return { p, at, L };
  });
}
function updateProgress() {
  const doc = document.documentElement.scrollHeight - innerHeight;
  const t = doc > 0 ? clamp01(scrollY / doc) : 0;
  progGrow.style.strokeDashoffset = `${progLen * (1 - t)}`;
  twigList.forEach((w) => { w.p.style.strokeDashoffset = t >= w.at ? '0' : `${w.L}`; });
}

// ---------------- рукописные подписи дорисовываются по скроллу
const hands = $$('[data-hand]');
function updateHands() {
  const vh = innerHeight;
  hands.forEach((el) => {
    if (reduce) { el.style.setProperty('--p', 1); return; }
    const r = el.getBoundingClientRect();
    if (r.bottom < -50 || r.top > vh + 50) return;
    const p = clamp01((vh * 0.95 - r.top) / (vh * 0.3 + r.height));
    el.style.setProperty('--p', p.toFixed(3));
  });
}

// ---------------- появление карточек, штампов, счётчики
const fmt = (v, dec) => v.toLocaleString('ru-RU', { minimumFractionDigits: dec, maximumFractionDigits: dec });
function runCounters(root) {
  $$('[data-count]', root).forEach((el) => {
    const to = parseFloat(el.dataset.count), dec = parseInt(el.dataset.dec || '0', 10);
    if (reduce) { el.textContent = fmt(to, dec); return; }
    const t0 = performance.now(), dur = 1700;
    const step = (now) => {
      const k = clamp01((now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(to * e, dec);
      if (k < 1) requestAnimationFrame(step);
    };
    el.textContent = fmt(0, dec);
    requestAnimationFrame(step);
  });
}
const io = new IntersectionObserver((entries) => {
  entries.forEach((en) => {
    if (!en.isIntersecting) return;
    const el = en.target;
    el.classList.add('in');
    if (el.classList.contains('sheet--d')) runCounters(el);
    io.unobserve(el);
  });
}, { threshold: 0.2, rootMargin: '0px 0px -8% 0px' });
$$('.card, .sheet, [data-stamp]').forEach((el) => io.observe(el));

// ---------------- главный цикл
let sceneHidden = false;
function onScroll() {
  fTarget = computeF();
  updateProgress();
  updateHands();
  const hide = appendices.getBoundingClientRect().top < innerHeight * 0.02;
  if (hide !== sceneHidden) {
    sceneHidden = hide;
    $('#scene').classList.toggle('off', hide);
    $('#labels').style.visibility = hide ? 'hidden' : '';
    if (hide) setLens(-999, -999, false);
  }
}
function onResize() {
  measure(); buildProgress(); gl?.resize(); onScroll(); drawMap();
}
addEventListener('scroll', onScroll, { passive: true });
addEventListener('resize', onResize);
document.fonts?.ready.then(onResize);

let last = performance.now(), time = 0, viewOff = 0;
const cardSide = chapters.map((c) => c.querySelector('.card')?.dataset.side || 'left');
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, (now - last) / 1000); last = now;
  if (!reduce) time += dt;
  fCur = reduce ? fTarget : lerp(fCur, fTarget, 1 - Math.exp(-dt * 3.2));
  if (Math.abs(fCur - fTarget) < 1e-4) fCur = fTarget;
  modeCur = reduce ? modeTarget : lerp(modeCur, modeTarget, 1 - Math.exp(-dt * 7));
  if (Math.abs(modeCur - modeTarget) < 0.005) modeCur = modeTarget;
  if (!gl || sceneHidden || document.hidden) return;
  lens.r = innerWidth < 720 ? 64 : 92;
  const ci = Math.min(8, Math.floor(fCur));
  const offT = fCur < 0.05 ? 0 : (cardSide[ci] === 'left' ? -0.2 : 0.2) * innerWidth;
  viewOff = reduce ? offT : lerp(viewOff, offT, 1 - Math.exp(-dt * 2.5));
  gl.update(fCur, time, reduce ? snapF(fCur) : fCur, viewOff);
  gl.render(modeCur, lens);
}
/** при reduced-motion камера не летит, а стоит в кадре главы; состояния следуют скроллу */
function snapF(f) {
  if (f < 0.05) return 0;
  return Math.min(8, Math.floor(f)) + 0.5;
}

// ================================================================ приложение A: клетки
function buildCells() {
  const NS = 'http://www.w3.org/2000/svg';
  const r2 = mulberry32(7);
  [['cells-ecm', 'ecm'], ['cells-am', 'am']].forEach(([id, kind]) => {
    const g = document.getElementById(id); if (!g) return;
    for (let ring = 0; ring < 5; ring++) {
      const rr = 45 + ring * 14, n = Math.floor((2 * Math.PI * rr) / 14.5);
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2 + ring * 0.2;
        const x = 150 + Math.cos(a) * rr, y = 150 + Math.sin(a) * rr;
        const c = document.createElementNS(NS, 'ellipse');
        c.setAttribute('cx', x.toFixed(1)); c.setAttribute('cy', y.toFixed(1));
        c.setAttribute('rx', '6.2'); c.setAttribute('ry', '5.4');
        c.setAttribute('transform', `rotate(${((a * 180) / Math.PI).toFixed(0)} ${x.toFixed(1)} ${y.toFixed(1)})`);
        c.setAttribute('class', kind === 'ecm' && ring >= 3 ? 'hartig' : 'cell');
        g.appendChild(c);
        if (kind === 'am' && ring >= 1 && ring <= 3 && r2() < 0.3) {
          const p = document.createElementNS(NS, 'path');
          const s = 4.2;
          p.setAttribute('d', `M${x - s} ${y + s} L${x} ${y} M${x} ${y} l${-s * 0.6} ${-s} M${x} ${y} l${s * 0.2} ${-s * 1.1} M${x} ${y} l${s} ${-s * 0.4} M${x - 2} ${y - 3} l-2 -1.5 M${x + 2.5} ${y - 2.5} l1.5 -2`);
          p.setAttribute('class', 'arb');
          g.appendChild(p);
        }
      }
    }
  });
}
buildCells();

// ================================================================ приложение C: карта
const LAND_MASK = 'AAAAAAAAAAAAAAAAAAAAAADg/wEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADA/v8/AOD//z8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD+///D/////5//AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPAH/j/+//////8PAAAAgB0AAHgAAAAAAH8AAAAAAAAAAAAAAAAAAAAAAAAAAOD//wP8//////8BAACAfx4AAAAAAAAAAP4AAAAAAAAAAAAAAAAAAAAAAAA4+I73//n///////8AAAAAfwAAAAAAAAAAAAAfAAAAAAAAAAAAAAAAAAAAAOAQACDwP4D///////8BAAAAPAQAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAADzAgPP5H8D//////38AAAAAAAAAAAAA4AEAAAD+DwAAAAAAAAAAAAAAAAAAAIC/g7PfBwAA/v////8AAAAAAAAAAADgBwAAwP//PwAA4B8AAAAAAAAAAAAAAAAMAAB8AgAA+P////8AAAAAAAAAAABwAAAA/P//AwAAAAAAAAAAAAAAAAAAAP8Ahvc5OwAA8P///38AAAAAAAAAAAAcAADg////34cHAAcAAAAAAAAAAAAAgN9/xzf8RwAA4P///z8AAAAAAAAAAAAPAB7g//////8fgD8AAAAAAQAAAAAAAO//B3f8/wsA4P///z8AAAAAAAAAAAAPAG////////8f2f8HAAAAAAD4HwAAAAD4H/D4/38A4P///xMAAAAAAPAHAAAAgN//////////////DwAAAAD+///h/4//H+/Bg/8BwP7//w8AAAAAwP8fAAAAj9///////////////88/A+D///////8DB8TPB/4AAP///wAAAAAA8P//AwDjf77/////////////////DwD////////////vh/kPwP//BwAAAAAA/P//H/P//5//////////////////34H8////////////Afw/gP//AQAQAAAA/v8fH////+///////////////////vD///////////9fAPwYgP8PAOA/AAAA/+N/8P//////////////////////QID4///////////Pw/0DAP8HAMAfAACA//F//v////////////////////8/AAP4///////////BBPAHAP4HAAAAAADg//z///////////////////////9/AID///////////8AQ4ABAPwBAAAAAAD8P/7///////////////////////9fAMD//////////z8AwA8AAPgBAAAAAAD+H/7/////////////////////Of8BAID///z//////z8AwD8AAMABAAAAAAD+P/z///////////////////9/wH8AAAD8MwD//////x8AwH8MAAAAAAAAAAD+P2D///////////////////95cAAAAACAAwD8/////38AwP8eAAAAAAAAgAGcH/D//////////////////wEAOAAAAADADgDA/////38AgP8/AAAAAAAAwANAH/T//////////////////wAAfgAAAAAwAAAA//////8PgP8/AAAAAAAAwAFwD/7/////////////////PwAAfwAAAAAGAAAA//////8/wP//AAAAAAAAwAOwA/7/////////////////DwCAPwAAAIAAAAAA/v//////8///BwAAAAAAOAcgcP//////////////////HwAAHwAAAAAAAACA+P//////4///DwAAAAAAOA74/////////////////////wUADwAAAAAAAAAA8P//////4///DwAAAAAAGD///////////////////////wUAAwAAAAAAAAAA8P//////7///FwAAAAAAAB///////////////////////wUAAgAAAAAAAAAA0P//////////DAAAAAAAgOH//////////////////////w0AAAAAAAAAAAAAYP////////8xLAAAAAAAAPz//////////////////////wwAAAAAAAAAAAAAAP7//////38HfgAAAAAAgP///////////////////////wQAAAAAAAAAAAAAAP3///////8HUAAAAAAAAP7/////////////////////fwQAAAAAAAAAAAAAAP////////+XAAAAAAAAAPz///93/D/+////////////PwwAAAAAAAAAAAAAAP////////9/AAAAAAAAAPj//f9j/g/+////////////HwAAAAAAAAAAAAAAAP////////8MAAAAAAAAAPj/+P8B/Mf/////////////DwQAAAAAAAAAAAAAAP///////z8AAAAAAAAAcPzH8/8A8I//////////////Bx4AAAAAAAAAAAAAAP///////x8AAAAAAAAA+H+Aw/8AwA/+//////////9/AA8AAAAAAAAAAAAAAP///////x8AAAAAAAAA+D8Aj//w4R/8//////////8/AAAAAAAAAAAAAAAAAP///////wMAAAAAAAAA+B8wuE/+/z/+/////////98fAAMAAAAAAAAAAAAAAP///////wMAAAAAAAAA+A8wEMf//x/+/////////0cOAAMAAAAAAAAAAAAAAP7//////wEAAAAAAAAA+A8AAM7//x/8/////////wMOAAEAAAAAAAAAAAAAAP7//////wAAAAAAAAAA+AcABob//z/8/////////zccwAEAAAAAAAAAAAAAAPz//////wAAAAAAAAAAQOB/AAQ2/////////////x8c8AEAAAAAAAAAAAAAAPj//////wAAAAAAAAAAQPx/AAAA/////////////w8Y/gEAAAAAAAAAAAAAAPD/////fwAAAAAAAAAA4P8/AAAA/////////////w+EGwAAAAAAAAAAAAAAAMD/////HwAAAAAAAAAA8P9/AACA/////////////x/AAwAAAAAAAAAAAAAAAID/////DwAAAAAAAAAA+P//BwaA/////////////x/AAAAAAAAAAAAAAAAAAID9////BwAAAAAAAAAA/P//D3+E/////////////z9AAAAAAAAAAAAAAAAAAAD5////BwAAAAAAAAAA/P//f////////////////x8AAAAAAAAAAAAAAAAAAADy/x8GBgAAAAAAAAAA/P/////v/8///////////z8AAAAAAAAAAAAAAAAAAAD0/w8ABgAAAAAAAAAA/v////+//4///////////z8AAAAAAAAAAAAAAAAAAADu/wcADgAAAAAAAACA//////8f/x/+/////////x8AAAAAAAAAAAAAAAAAAACI/wcALAAAAAAAAADA//////8//z/g/////////w8AAAAAAAAAAAAAAAAAAACQ/wcACAAAAAAAAADg//////9//r+A/////////wcAAAAAAAAAAAAAAAAAAAAQ/wMAAAAAAAAAAADg//////9//n8cgP///////ycAAAAAAAAAAAAAAAAAAAAA/gMAAAAAAAAAAADw////////+P9/AP///////xEAAAAAAAAAAAAAAAAAAAAA/AMAHQAAAAAAAADw////////+P//APz/f///fxAAAAAAAAAAAAAAAAAAAAAA+AcAYAAAAAAAAAD4////////+f9/APz/B///BgAAAAAAAAAAAAAAAAAAAAAA/AccgAEAAAAAAADw////////8f9/AOD/B/5/AAAAAAAAAAAAAAAAAQAAAAAA+A8eADgAAAAAAADw////////4f8/AOD/Afw/BgAAAAAAAAAAAAAAAAAAAAAA8J8PAPwCAAAAAADw////////4/8fAOD/APw/AgAAAAAAAAAAAAAAAAAAAAAAgP8PAAAAAAAAAADw////////x/8HAOB/APx/ADAAAAAAAAAAAAAAAAAAAAAAAP4PAAAAAAAAAAD4////////h/8BAOA/APz/ADAAAAAAAAAAAAAAAAAAAAAAAID/AAAAAAAAAAD4////////j/8AAMAPAMD/ATAAAAAAAAAAAAAAAAAAAAAAAAD/AQAAAAAAAAD4////////nx8AAMAPAMD/ATAAAAAAAAAAAAAAAAAAAAAAAAD8AAAAAAAAAAD4////////vwcAAIAPAMD/AcAAAAAAAAAAAAAAAAAAAAAAAADgAQAAAAAAAAD4////////fwAAAIAPAMD8AQABAAAAAAAAAAAAAAAAAAAAAADAAAgAAAAAAADw////////f2AAAAAPAID4AUACAAAAAAAAAAAAAAAAAAAAAADAAe9TAAAAAADg/////////34AAAAPAEBwAAgAAAAAAAAAAAAAAAAAAAAAAAAAE+9/AAAAAADA/////////38AAAAXAEAgAAQCAAAAAAAAAAAAAAAAAAAAAAAAz///AAAAAACA/////////z8AAAASAMAAAIACAAAAAAAAAAAAAAAAAAAAAAAAyP//AQAAAACA/////////z8AAAAwAIAAAEAHAAAAAAAAAAAAAAAAAAAAAAAAgP//AwAAAAAA/v///////x8AAAAwAAADAAMBAAAAAAAAAAAAAAAAAAAAAAAAwP//fwAAAAAA/A/+/////x8AAAAAAAAHAAcAAAAAAAAAAAAAAAAAAAAAAAAAgP///wAAAAAAEAD8/////w8AAAAAADAGwAcAAAAAAAAAAAAAAAAAAAAAAAAAgP///wEAAAAAAADA/////wcAAAAAAGAG4AEAAAAAAAAAAAAAAAAAAAAAAAAA4P///wEAAAAAAADA/////wMAAAAAAMAM+AMAAAAAAAAAAAAAAAAAAAAAAAAA4P///wMAAAAAAADg/////wEAAAAAAIAL/gMQAAAAAAAAAAAAAAAAAAAAAAAA8P///wMAAAAAAADg////fwAAAAAAAIAH/vMQAAAAAAAAAAAAAAAAAAAAAAAA8P///wcAAAAAAADg////PwAAAAAAAAAP/gMAAQAAAAAAAAAAAAAAAAAAAAAA+P///38AAAAAAADg////PwAAAAAAAAAO/DmAAwAAAAAAAAAAAAAAAAAAAAAA+P///38BAAAAAADA////HwAAAAAAAAA+/DkA8gAAAAAAAAAAAAAAAAAAAAAA8P////8fAAAAAACA////DwAAAAAAAAA8wChE/gcAAAAAAAAAAAAAAAAAAAAA+P////8/AAAAAACA////BwAAAAAAAAA4AEAA8B8AAAAAAAAAAAAAAAAAAAAA+P//////AQAAAAAA////BwAAAAAAAAAwAEAAxD8NAAAAAAAAAAAAAAAAAAAA+P//////AQAAAAAA////BwAAAAAAAADAAQAAxP+AAAAAAAAAAAAAAAAAAAAA8P//////AQAAAAAA/v//BwAAAAAAAACAHwAAwH8ABAAAAAAAAAAAAAAAAAAA4P//////AQAAAAAA/v//BwAAAAAAAAAAQFYEAMcAAAAAAAAAAAAAAAAAAAAA4P//////AAAAAAAA/v//DwAAAAAAAAAAAAgBAIABMAAAAAAAAAAAAAAAAAAAwP//////AAAAAAAA/v//DwAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAgP////9/AAAAAAAA/P//DwAAAAAAAAAAAAAAAQQAAAAAAAAAAAAAAAAAAAAAgP////8/AAAAAAAA/v//HyAAAAAAAAAAAACAHwQAAAAAAAAAAAAAAAAAAAAAAP////8fAAAAAAAA/v//HyAAAAAAAAAAAADADwwAAAAAAAAAAAAAAAAAAAAAAP////8fAAAAAAAA////HzAAAAAAAAAAAADsDxwAAAAAAAAAAAAAAAAAAAAAAP7///8fAAAAAAAA////DzgAAAAAAAAAAAD/DxwAAAAAAAAAAAAAAAAAAAAAAPj///8fAAAAAAAA////Dz8AAAAAAAAAAAD/Pz4AAAiAAAAAAAAAAAAAAAAAAOD///8fAAAAAAAA////Ax8AAAAAAAAAAMD//z4AAABAAAAAAAAAAAAAAAAAAMD///8PAAAAAAAA////AB8AAAAAAAAAAMD//z8AAAAAAAAAAAAAAAAAAAAAAMD///8PAAAAAAAA/v9/AB8AAAAAAAAAAOD//38AAAAAAAAAAAAAAAAAAAAAAMD///8PAAAAAAAA/v9/AB8AAAAAAAAAAPz///8BAAEAAAAAAAAAAAAAAAAAAMD///8HAAAAAAAA/P9/gA8AAAAAAAAAgP////8BAAIAAAAAAAAAAAAAAAAAAMD///8DAAAAAAAA/P//gA8AAAAAAAAAwP////8DAAAAAAAAAAAAAAAAAAAAAMD//38AAAAAAAAA/P9/AA8AAAAAAAAAwP////8HAAAAAAAAAAAAAAAAAAAAAOD//x8AAAAAAAAA+P9/AAcAAAAAAAAA4P////8PAAAAAAAAAAAAAAAAAAAAAOD//w8AAAAAAAAA+P8fAAIAAAAAAAAAwP////8fAAAAAAAAAAAAAAAAAAAAAOD//wcAAAAAAAAA+P8fAAAAAAAAAAAA4P////8fAAAAAAAAAAAAAAAAAAAAAOD//wcAAAAAAAAA+P8fAAAAAAAAAAAAwP////8fAAAAAAAAAAAAAAAAAAAAAOD//wcAAAAAAAAA8P8PAAAAAAAAAAAAgP////8/AAAAAAAAAAAAAAAAAAAAAOD//wMAAAAAAAAA4P8HAAAAAAAAAAAAgP////8fAAAAAAAAAAAAAAAAAAAAAPD//wMAAAAAAAAA4P8HAAAAAAAAAAAAgP////8fAAAAAAAAAAAAAAAAAAAAAPD//wEAAAAAAAAAwP8DAAAAAAAAAAAAAP////8fAAAAAAAAAAAAAAAAAAAAAOD//wAAAAAAAAAAwP8BAAAAAAAAAAAAAP8D/P8PAAAAAAAAAAAAAAAAAAAAAPD/fwAAAAAAAAAAwH8AAAAAAAAAAAAAgP8A2P8HAAAAAAAAAAAAAAAAAAAAAPD/OwAAAAAAAAAAgAEAAAAAAAAAAAAAAAcA6P8HAAAAAAAAAAAAAAAAAAAAAPj/BwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAwP8DAAACAAAAAAAAAAAAAAAAAPj/BwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8DAAAEAAAAAAAAAAAAAAAAAPz/BwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8DAAAIAAAAAAAAAAAAAAAAAPj/AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGgAAAA4AAAAAAAAAAAAAAAAAPg/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAcAAAAAAAAAAAAAAAAAPw/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAYAAAAAAAAAAAAAAAAAPwHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAAALAAAAAAAAAAAAAAAAAPwfAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAOAAAIADAAAAAAAAAAAAAAAAAPgHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAMABAAAAAAAAAAAAAAAAAPwHAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHAAAAAAAAAAAAAAAAAAAP4BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHgAAAAAAAAAAAAAAAAAAP4BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADAAAAAAAAAAAAAAAAAAAP4DAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAP8AAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAH4AAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAAAAAA';
const MW = 360, MH = 150;
const landBits = Uint8Array.from(atob(LAND_MASK), (c) => c.charCodeAt(0));
const isLand = (i, j) => { const n = j * MW + i; return (landBits[n >> 3] >> (n & 7)) & 1; };

const BIOMES = {
  boreal: { name: 'Тайга', mix: [0.8, 0.05, 0.15], dens: 0.8, text: 'Эктомикориза: сосна, ель, лиственница, берёза. Опад разлагается медленно, азот «заперт» в органике — ЭКМ-грибы умеют его добывать. В подлеске у черники и брусники — эрикоидная микориза.' },
  tundra: { name: 'Тундра', mix: [0.35, 0.15, 0.5], dens: 0.3, text: 'Эрикоидная микориза у голубики, вороники, багульника и эктомикориза у карликовой берёзы и ив. Растительность низкая и редкая.' },
  temperate: { name: 'Широколиственные и смешанные леса', mix: [0.5, 0.5, 0], dens: 0.8, text: 'Мозаика: дуб, бук, граб, липа, сосна — эктомикориза; клён, ясень, вишня и почти все травы — арбускулярная.' },
  nothofagus: { name: 'Леса южного бука', mix: [0.75, 0.25, 0], dens: 0.7, text: 'Чили, Аргентина, Новая Зеландия: нотофагусы образуют эктомикоризу, как бук и дуб на севере.' },
  mediterranean: { name: 'Средиземноморские кустарники', mix: [0.35, 0.65, 0], dens: 0.5, text: 'Дубы и сосны — эктомикориза, большинство кустарников и трав — арбускулярная.' },
  steppe: { name: 'Степи и прерии', mix: [0.03, 0.97, 0], dens: 0.55, text: 'Злаки и разнотравье — почти целиком арбускулярная микориза.' },
  desert: { name: 'Пустыни', mix: [0.02, 0.98, 0], dens: 0.12, text: 'Растений мало. Преобладает арбускулярная микориза; многие маревые и капустные пустынь обходятся без грибов.' },
  rainforest: { name: 'Влажные тропические леса', mix: [0.06, 0.94, 0], dens: 0.95, text: 'Большинство тропических деревьев — арбускулярная микориза. Разложение быстрое, фосфор в дефиците.' },
  dipterocarp: { name: 'Диптерокарповые леса', mix: [0.45, 0.55, 0], dens: 0.95, text: 'Юго-Восточная Азия: огромные диптерокарпы образуют эктомикоризу среди арбускулярного тропического леса.' },
  miombo: { name: 'Редколесья миомбо', mix: [0.4, 0.6, 0], dens: 0.6, text: 'Южная часть тропической Африки: бобовые деревья брахистегии образуют эктомикоризу — «островок» ЭКМ в тропиках.' },
  savanna: { name: 'Саванны и сухие тропики', mix: [0.05, 0.95, 0], dens: 0.5, text: 'Злаки, акации, баобабы — арбускулярная микориза.' },
  eucalypt: { name: 'Эвкалиптовые леса', mix: [0.45, 0.55, 0], dens: 0.45, text: 'Эвкалипты умеют образовывать и эктомикоризу, и арбускулярную — часто обе сразу.' },
  ice: { name: 'Ледники', mix: [0, 0, 0], dens: 0, text: 'Растений почти нет — и микоризы тоже.' },
};
function biome(lat, lon) {
  const box = (la0, la1, lo0, lo1) => lat >= la0 && lat <= la1 && lon >= lo0 && lon <= lo1;
  if (lat < -60 || box(60, 84, -58, -15) || box(76, 84, -80, -10)) return 'ice';
  if (lat >= 68 || box(58, 68, -100, -60) || box(60, 68, -168, -150) || box(64, 68, 60, 180)) return 'tundra';
  if (box(45, 56, 30, 90) || box(42, 50, 90, 120) || box(30, 52, -110, -96) || box(-40, -29, -65, -56)) return 'steppe';
  if (box(56, 68, 10, 180) || box(50, 56, 90, 145) || box(49, 68, -170, -52)) return 'boreal';
  if (box(15, 30, -17, 35) || box(12, 33, 35, 62) || box(25, 45, 50, 75) || box(36, 45, 90, 115) || box(22, 30, 68, 76) ||
      box(-32, -19, 118, 145) || box(25, 37, -118, -103) || box(-30, -14, -72, -68) || box(-29, -17, 12, 22) || box(-52, -38, -71, -63)) return 'desert';
  if (box(-56, -37, -76, -71) || box(-47, -34, 165, 179)) return 'nothofagus';
  if (box(30, 42.5, -10, 40) || box(32, 38.5, -124, -116) || box(-35, -32, 17, 22) || box(-36, -30, 114, 120)) return 'mediterranean';
  if (box(42, 60, -10, 50) || box(28, 50, 100, 146) || box(29, 50, -96, -60) || box(38, 50, -125, -115)) return 'temperate';
  if (box(-44, -25, 138, 154) || box(-20, -10, 120, 150)) return 'eucalypt';
  if (box(-10, 20, 95, 155)) return 'dipterocarp';
  if (box(-18, -5, 12, 40)) return 'miombo';
  if (box(-12, 8, -80, -45) || box(-5, 5, 8, 30) || box(8, 20, -95, -76)) return 'rainforest';
  if (Math.abs(lat) < 24) return 'savanna';
  return lat > 0 ? 'temperate' : 'savanna';
}
const mapCanvas = $('#map');
const mapTip = $('#map-tip');
const mapList = $('#map-list');
let mapHover = null;
const mapDots = [];
{
  const r = mulberry32(99);
  for (let j = 0; j < MH; j++) for (let i = 0; i < MW; i++) {
    if (!isLand(i, j)) continue;
    const lat = 84 - j - 0.5, lon = -180 + i + 0.5;
    const b = biome(lat, lon); const B = BIOMES[b];
    for (let s = 0; s < 2; s++) {
      if (r() > B.dens) continue;
      const x = r(), m = B.mix; const type = x < m[0] ? 0 : x < m[0] + m[1] ? 1 : 2;
      mapDots.push({ x: (i + r()) * 2, y: (j + r()) * 2, t: type, b, s: 0.7 + r() * 0.5 });
    }
  }
}
Object.entries(BIOMES).forEach(([k, B]) => {
  if (k === 'ice') return;
  const btn = document.createElement('button');
  btn.type = 'button'; btn.textContent = B.name; btn.dataset.b = k; btn.setAttribute('aria-pressed', 'false');
  btn.addEventListener('click', () => showBiome(mapHover === k ? null : k, true));
  mapList.appendChild(btn);
});
function showBiome(k, fromBtn) {
  mapHover = k;
  $$('button', mapList).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.b === k)));
  if (k) {
    const B = BIOMES[k];
    mapTip.innerHTML = `<b>${B.name}</b><br>${B.text}`;
    mapTip.classList.add('on');
  } else mapTip.classList.remove('on');
  drawMap();
  if (fromBtn && k) mapCanvas.scrollIntoView({ block: 'nearest', behavior: reduce ? 'auto' : 'smooth' });
}
function drawMap() {
  if (!mapCanvas) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cw = mapCanvas.clientWidth || 720;
  const scale = cw / 720;
  mapCanvas.width = Math.round(cw * dpr); mapCanvas.height = Math.round(300 * scale * dpr);
  const c = mapCanvas.getContext('2d');
  c.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
  c.fillStyle = PAPER_HEX; c.fillRect(0, 0, 720, 300);
  // растровая сетка океана
  c.fillStyle = 'rgba(42,92,170,.16)';
  for (let y = 3; y < 300; y += 6) for (let x = (y / 6) % 2 ? 3 : 0; x < 720; x += 6) { c.beginPath(); c.arc(x, y, 0.7, 0, 7); c.fill(); }
  c.globalCompositeOperation = 'multiply';
  const cols = [INK.pink, INK.green, INK.blue];
  const offs = [[0.8, -0.5], [0, 0], [-0.6, 0.7]];
  for (let t = 0; t < 3; t++) {
    c.fillStyle = cols[t];
    for (const d of mapDots) {
      if (d.t !== t) continue;
      const dim = mapHover && d.b !== mapHover;
      c.globalAlpha = dim ? 0.18 : 0.95;
      const rr = (dim ? 1 : mapHover ? 1.35 : 1.05) * d.s;
      c.beginPath(); c.arc(d.x + offs[t][0], d.y + offs[t][1], rr, 0, 7); c.fill();
    }
  }
  c.globalAlpha = 1; c.globalCompositeOperation = 'source-over';
  c.strokeStyle = 'rgba(28,58,42,.35)'; c.setLineDash([3, 4]);
  const eqY = 84 * 2;
  c.beginPath(); c.moveTo(0, eqY); c.lineTo(720, eqY); c.stroke();
  c.setLineDash([]);
  c.font = '600 15px Caveat, cursive'; c.fillStyle = '#46463f';
  c.fillText('экватор', 8, eqY - 5);
}
function mapPick(e) {
  const r = mapCanvas.getBoundingClientRect();
  const x = ((e.clientX - r.left) / r.width) * 720, y = ((e.clientY - r.top) / r.height) * 300;
  const i = Math.floor(x / 2), j = Math.floor(y / 2);
  if (i < 0 || j < 0 || i >= MW || j >= MH) return null;
  // ищем сушу рядом (1–2 клетки), чтобы попадать по побережьям
  for (let d = 0; d <= 2; d++) for (let dj = -d; dj <= d; dj++) for (let di = -d; di <= d; di++) {
    const ii = i + di, jj = j + dj;
    if (ii >= 0 && jj >= 0 && ii < MW && jj < MH && isLand(ii, jj)) {
      const b = biome(84 - jj - 0.5, -180 + ii + 0.5);
      return b === 'ice' ? 'ice' : b;
    }
  }
  return null;
}
if (mapCanvas) {
  mapCanvas.addEventListener('pointermove', (e) => { const b = mapPick(e); if (b !== mapHover) showBiome(b); });
  mapCanvas.addEventListener('pointerleave', () => showBiome(null));
  mapCanvas.addEventListener('click', (e) => showBiome(mapPick(e)));
}

// ================================================================ старт
measure(); buildProgress(); onScroll(); drawMap();
fCur = fTarget;
requestAnimationFrame(frame);
