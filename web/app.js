import * as THREE from './vendor/three.module.js';
import {OrbitControls} from './vendor/OrbitControls.js';

/* ================= chemistry data ================= */
const EL = {
  // val: usual valence · neutral: bond counts without a charge · plus: bonds reachable as a + ion
  H: {c:0xffffff, r:0.31, val:1, vis:0.22, name:'Hydrogen', neutral:[1], plus:0},
  C: {c:0x9aa3ad, r:0.76, val:4, vis:0.36, name:'Carbon',   neutral:[4], plus:0},
  N: {c:0x3d6bff, r:0.71, val:3, vis:0.34, name:'Nitrogen', neutral:[3], plus:4},
  O: {c:0xff3b3b, r:0.66, val:2, vis:0.33, name:'Oxygen',   neutral:[2], plus:3},
  S: {c:0xe040fb, r:1.05, val:2, vis:0.42, name:'Sulfur',   neutral:[2,4,6], plus:0},
  F: {c:0x7ee06a, r:0.57, val:1, vis:0.30, name:'Fluorine', neutral:[1], plus:0},
};
const ORDER = [0, 1, 0.87, 0.78];   // bond-length factor for single/double/triple
const MAX_HEAVY = 10;
const MAX_RADICALS = 2;  // unpaired electrons allowed per molecule
const KB = 300, KA = 60, KR = 5;    // toy force field constants (kcal/mol-ish)

/* ================= storage ================= */
const LS = {
  get(k, d){ try{ const v = localStorage.getItem(k); return v==null ? d : JSON.parse(v); }catch{ return d; } },
  set(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); }catch{} }
};
let total   = LS.get('qm.total', 0);
const seen  = new Set(LS.get('qm.seen', []));
const records = LS.get('qm.records', {});       // formula -> best energy
const history = LS.get('qm.history', []);       // [{smiles, formula, score, pubNew}]
const pcCache = LS.get('qm.pubchem', {});       // smiles -> true(new)/false(known)

/* ================= server (online mode) ================= */
// When the page is served by the QuMol backend, scoring happens on the server and
// everything is saved there. Opened as a plain file, the game falls back to local play.
let ONLINE = false;
let token = LS.get('qm.token', null), nick = LS.get('qm.nick', null);
async function api(path, {method='GET', body} = {}){
  const headers = {};
  if(body) headers['Content-Type'] = 'application/json';
  if(token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(path, {method, headers, body: body ? JSON.stringify(body) : undefined});
  let j = null; try{ j = await r.json(); }catch{}
  if(!r.ok){
    let msg = j && j.detail;
    if(Array.isArray(msg)) msg = msg.map(d => d.msg).join('; ');
    const e = new Error(msg || `Server error ${r.status}`); e.status = r.status; throw e;
  }
  return j;
}
async function detectServer(){
  try{
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 8000);
    const r = await fetch('/api/health', {signal: ctl.signal});
    ONLINE = r.ok && !!(await r.json()).ok;
  }catch{ ONLINE = false; }
}
function setAccount(t, n){ token = t; nick = n; LS.set('qm.token', t); LS.set('qm.nick', n); }

/* ================= state ================= */
let atoms = [], bonds = [];
let mode = 'add', element = 'C', bondFirst = null, dragging = null, busy = false;
let undoStack = [], shake = 0, muted = LS.get('qm.muted', false);
let measureOn = LS.get('qm.measure', false), focusAtom = null;  // measure tool: angles are shown around focusAtom
const $ = id => document.getElementById(id);

/* ================= three.js setup ================= */
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({canvas, antialias:true});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1020);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 500);
camera.position.set(0, 0, 9);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.enablePan = false;
controls.minDistance = 2.5; controls.maxDistance = 40;
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x20182f, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(4, 6, 8); scene.add(sun);
const rim = new THREE.DirectionalLight(0x7c5cff, 0.8); rim.position.set(-6, -3, -5); scene.add(rim);
const world = new THREE.Group(); scene.add(world);
const molGroup = new THREE.Group(); world.add(molGroup);

// starfield
{
  const n = 600, p = new Float32Array(n*3);
  for(let i=0;i<n;i++){ const v = randUnit().multiplyScalar(60 + Math.random()*80); p.set([v.x,v.y,v.z], 3*i); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p,3));
  const stars = new THREE.Points(g, new THREE.PointsMaterial({color:0x8fa3ff, size:0.5, transparent:true, opacity:0.6}));
  stars.name = 'stars'; scene.add(stars);
}

function resize(){
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();

const sphereGeo = new THREE.SphereGeometry(1, 28, 18);
const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 14);
const mats = {}; for(const e in EL) mats[e] = new THREE.MeshStandardMaterial({color:EL[e].c, roughness:0.32, metalness:0.08});
const selMat = new THREE.MeshStandardMaterial({color:0xffffff, emissive:0x7c5cff, emissiveIntensity:1.3});
const bondMat = new THREE.MeshStandardMaterial({color:0xc9d1e8, roughness:0.4});
const hoverBondMat = new THREE.MeshStandardMaterial({color:0xffffff, emissive:0x20d3a7, emissiveIntensity:0.9, roughness:0.3});
let hoverBond = -1;
// During the optimization movie, a bond stretched past 1.5x a normal single bond has
// been torn apart, so it isn't drawn. While editing, bonds always draw normally.
function torn(b, L){
  return L > 1.5 * (EL[atoms[b.a].el].r + EL[atoms[b.b].el].r);
}
const Y = new THREE.Vector3(0,1,0);

function randUnit(){
  const z = Math.random()*2-1, t = Math.random()*Math.PI*2, s = Math.sqrt(1-z*z);
  return new THREE.Vector3(s*Math.cos(t), s*Math.sin(t), z);
}
function perpOf(d){
  const a = Math.abs(d.y) < 0.9 ? Y : new THREE.Vector3(1,0,0);
  return new THREE.Vector3().crossVectors(d, a).normalize();
}

function rebuild(){
  molGroup.clear();
  const now = performance.now();
  atoms.forEach((a, i) => {
    const m = new THREE.Mesh(sphereGeo, i === bondFirst || i === dragging ? selMat : mats[a.el]);
    let s = EL[a.el].vis;
    if(a.born){ const t = (now - a.born)/350; if(t < 1) s *= t < 0.6 ? t/0.6*1.25 : 1.25 - 0.25*(t-0.6)/0.4; }
    m.scale.setScalar(Math.max(s, 0.001)); m.position.copy(a.p); molGroup.add(m);
  });
  bonds.forEach((b, bi) => {
    const p1 = atoms[b.a].p, p2 = atoms[b.b].p;
    const dir = p2.clone().sub(p1); const L = dir.length(); if(L < 1e-6) return; dir.normalize();
    if(busy && torn(b, L)) return;  // pulled apart during optimization: not a bond any more
    const perp = perpOf(dir).multiplyScalar(0.13);
    const offs = b.o === 1 ? [0] : b.o === 2 ? [-0.5, 0.5] : [-1, 0, 1];
    const rad = b.o === 1 ? 0.09 : 0.055;
    const mid = p1.clone().add(p2).multiplyScalar(0.5);
    for(const k of offs){
      const m = new THREE.Mesh(cylGeo, bi === hoverBond ? hoverBondMat : bondMat);
      m.scale.set(rad, L, rad); m.position.copy(mid).addScaledVector(perp, k);
      m.quaternion.setFromUnitVectors(Y, dir); molGroup.add(m);
    }
  });
}

/* ================= particles ================= */
const bursts = [];
const dotTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  const gr = g.createRadialGradient(32,32,0,32,32,32); gr.addColorStop(0,'rgba(255,255,255,1)'); gr.addColorStop(0.4,'rgba(255,255,255,.6)'); gr.addColorStop(1,'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0,0,64,64); return new THREE.CanvasTexture(c);
})();
function burst(pos, colors, count=26, speed=3, life=0.7, size=0.25, gravity=0){
  const p = new Float32Array(count*3), col = new Float32Array(count*3), vel = [], c = new THREE.Color();
  colors = [].concat(colors);
  for(let i=0;i<count;i++){
    p.set([pos.x,pos.y,pos.z], 3*i);
    vel.push(randUnit().multiplyScalar(speed*(0.35+Math.random()*0.8)));
    c.set(colors[i % colors.length]); col.set([c.r,c.g,c.b], 3*i);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p,3)); g.setAttribute('color', new THREE.BufferAttribute(col,3));
  const mat = new THREE.PointsMaterial({size, map:dotTex, vertexColors:true, transparent:true, depthWrite:false, blending:THREE.AdditiveBlending});
  const pts = new THREE.Points(g, mat); world.add(pts);
  bursts.push({pts, vel, age:0, life, gravity});
}
function updateBursts(dt){
  for(let k = bursts.length-1; k >= 0; k--){
    const b = bursts[k]; b.age += dt;
    const arr = b.pts.geometry.attributes.position.array;
    b.vel.forEach((v, i) => { v.multiplyScalar(0.95); v.y -= b.gravity*dt; arr[3*i]+=v.x*dt; arr[3*i+1]+=v.y*dt; arr[3*i+2]+=v.z*dt; });
    b.pts.geometry.attributes.position.needsUpdate = true;
    b.pts.material.opacity = Math.max(0, 1 - b.age/b.life);
    if(b.age >= b.life){ world.remove(b.pts); b.pts.geometry.dispose(); b.pts.material.dispose(); bursts.splice(k,1); }
  }
}

/* ================= sound ================= */
let ac = null;
function unlockAudio(){
  if(!ac){ try{ ac = new (window.AudioContext || window.webkitAudioContext)(); }catch{} }
  if(ac && ac.state === 'suspended') ac.resume();
}
function tone(f, d=0.12, type='sine', vol=0.2, f2=null, delay=0){
  if(!ac || muted) return;
  const t = ac.currentTime + delay, o = ac.createOscillator(), g = ac.createGain();
  o.type = type; o.frequency.setValueAtTime(f, t);
  if(f2) o.frequency.exponentialRampToValueAtTime(f2, t+d);
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t+0.012); g.gain.exponentialRampToValueAtTime(0.0001, t+d);
  o.connect(g).connect(ac.destination); o.start(t); o.stop(t+d+0.03);
}
const SFX = {
  pop(el){ const f = {H:950,C:520,N:600,O:680,S:420,F:760}[el] || 520; tone(f, 0.13, 'sine', 0.25, f*1.6); },
  bond(o){ tone(300+o*120, 0.08, 'triangle', 0.22); tone(450+o*170, 0.11, 'triangle', 0.16, null, 0.05); },
  del(){ tone(420, 0.2, 'sawtooth', 0.1, 90); },
  err(){ tone(150, 0.1, 'square', 0.1); tone(120, 0.13, 'square', 0.1, null, 0.12); },
  tick(i=0){ tone(700+i*90, 0.07, 'sine', 0.16); },
  chime(){ [660,880,1320].forEach((f,i)=>tone(f, 0.3, 'sine', 0.18, null, i*0.08)); },
  fanfare(){ [523,659,784,1047,784,1047].forEach((f,i)=>tone(f, i===5?0.7:0.17, 'square', 0.1, null, i*0.13)); },
  whoosh(){
    if(!ac || muted) return;
    const len = ac.sampleRate*0.9, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for(let i=0;i<len;i++) d[i] = Math.random()*2-1;
    const src = ac.createBufferSource(); src.buffer = buf;
    const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 2;
    const g = ac.createGain(), t = ac.currentTime;
    bp.frequency.setValueAtTime(300, t); bp.frequency.exponentialRampToValueAtTime(3500, t+0.8);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t+0.3); g.gain.exponentialRampToValueAtTime(0.0001, t+0.9);
    src.connect(bp).connect(g).connect(ac.destination); src.start(t);
  }
};
const buzz = p => { try{ navigator.vibrate && navigator.vibrate(p); }catch{} };

/* ================= molecule helpers ================= */
const neighbors = i => bonds.filter(b => b.a===i || b.b===i).map(b => b.a===i ? b.b : b.a);
const orderSum  = i => bonds.reduce((s,b) => s + ((b.a===i || b.b===i) ? b.o : 0), 0);
const maxBonds  = el => Math.max(...EL[el].neutral, EL[el].plus);
// Automatic formal charges (mirror of assign_charges in qumol/chem.py): an atom with one
// bond more than usual (O with 3, N with 4) becomes +, and the nearest heavy atom one bond
// short becomes −, keeping the molecule neutral: ⁻C≡O⁺, nitro groups. 'deficit' is what's
// left for hydrogens (or radicals).
let _vsKey = '', _vs = null;
function valenceState(){
  const key = atoms.map(a => a.el).join('') + '|' + bonds.map(b => `${b.a},${b.b},${b.o}`).join(';');
  if(key === _vsKey && _vs) return _vs;
  const n = atoms.length, total = atoms.map((_, i) => orderSum(i)), nb = atoms.map((_, i) => neighbors(i));
  const charge = new Array(n).fill(0), deficit = new Array(n).fill(0), plus = [], unbalanced = [];
  atoms.forEach((a, i) => {
    const e = EL[a.el], mx = Math.max(...e.neutral);
    if(total[i] > mx) plus.push(i);
    else deficit[i] = Math.min(...e.neutral.filter(v => v >= total[i])) - total[i];
  });
  for(const i of plus){
    const seen = new Set([i]); let frontier = [i], partner = -1;
    while(frontier.length && partner < 0){
      const next = [];
      for(const u of frontier){
        for(const v of nb[u]){
          if(seen.has(v)) continue; seen.add(v);
          if(atoms[v].el !== 'H' && deficit[v] > 0 && charge[v] === 0){ partner = v; break; }
          next.push(v);
        }
        if(partner >= 0) break;
      }
      frontier = next;
    }
    if(partner < 0){ unbalanced.push(i); continue; }
    charge[i] = 1; charge[partner] = -1; deficit[partner]--;
  }
  _vsKey = key; _vs = {charge, deficit, unbalanced};
  return _vs;
}
const freeVal   = i => valenceState().deficit[i];              // for growing and hydrogens
const freeMax   = i => maxBonds(atoms[i].el) - orderSum(i);    // for explicit bond edits
const freeHeavy = () => { const d = valenceState().deficit; return atoms.reduce((s, a, i) => s + (a.el !== 'H' ? d[i] : 0), 0); };
const heavyCount = () => atoms.filter(a => a.el !== 'H').length;
const findBond = (a,b) => bonds.find(x => (x.a===a && x.b===b) || (x.a===b && x.b===a));
function hybCos(i){
  const os = bonds.filter(b => b.a===i || b.b===i).map(b => b.o);
  const dbl = os.filter(o => o===2).length;
  return (os.includes(3) || dbl >= 2) ? -1 : dbl === 1 ? -0.5 : -1/3;
}
function newDir(i, jitter){
  const nb = neighbors(i), here = atoms[i].p;
  const vecs = nb.map(j => atoms[j].p.clone().sub(here).normalize());
  let d;
  if(nb.length === 0) d = randUnit();
  else if(nb.length === 1){
    const c0 = hybCos(i), s0 = Math.sqrt(1 - c0*c0);
    const perp = randUnit().cross(vecs[0]).normalize();
    d = vecs[0].clone().multiplyScalar(c0).add(perp.multiplyScalar(s0));
  } else {
    const s = vecs.reduce((acc,v) => acc.add(v), new THREE.Vector3());
    if(s.length() > 0.3) d = s.negate().normalize();
    else { d = new THREE.Vector3().crossVectors(vecs[0], vecs[1]); if(d.length() < 1e-3) d = perpOf(vecs[0]); d.normalize(); if(Math.random() < 0.5) d.negate(); }
  }
  return d.add(randUnit().multiplyScalar(jitter)).normalize();
}
function addAtom(el, pos){ atoms.push({el, p:pos.clone(), born:performance.now()}); return atoms.length-1; }
function growFrom(i, el){
  if(el !== 'H' && heavyCount() >= MAX_HEAVY) return fail(`Max ${MAX_HEAVY} heavy atoms`);
  if(freeVal(i) < 1) return fail(`That ${atoms[i].el} has no free bonds`);
  const d = newDir(i, 0.4);
  const r0 = EL[atoms[i].el].r + EL[el].r;
  const j = addAtom(el, atoms[i].p.clone().addScaledVector(d, r0*(0.88 + Math.random()*0.24)));
  bonds.push({a:i, b:j, o:1});
  SFX.pop(el); buzz(10); burst(atoms[j].p, EL[el].c, 18, 2.5, 0.5, 0.22);
}
function cycleBond(a, b){
  const ex = findBond(a, b), cur = ex ? ex.o : 0;
  let next = (cur + 1) % 4;
  const need = next - cur;
  if(next > 0 && (freeMax(a) < need || freeMax(b) < need)) next = 0;
  if(next === 0 && !ex) return fail('No free valence for a bond there');
  if(next === 0){ bonds.splice(bonds.indexOf(ex), 1); SFX.del(); }
  else if(ex){ ex.o = next; SFX.bond(next); }
  else { bonds.push({a, b, o:1}); SFX.bond(1); }
  buzz(12);
  burst(atoms[a].p.clone().add(atoms[b].p).multiplyScalar(0.5), 0xc9d1e8, 14, 2, 0.4, 0.18);
}
// Tap a bond: single → double → triple → single (within each atom's valence).
function cycleOrder(k){
  const b = bonds[k]; if(!b) return false;
  let next = b.o % 3 + 1;
  const need = next - b.o;
  if(need > 0 && (freeMax(b.a) < need || freeMax(b.b) < need)){
    if(b.o === 1){
      const full = freeMax(b.a) < need ? b.a : b.b;
      return fail(`${EL[atoms[full].el].name} has no free bond left for a double bond (max ${maxBonds(atoms[full].el)})`);
    }
    next = 1;
  }
  b.o = next;
  SFX.bond(next); buzz(12);
  burst(atoms[b.a].p.clone().add(atoms[b.b].p).multiplyScalar(0.5), 0x20d3a7, 14, 2, 0.4, 0.18);
  toast(['', 'Single bond', 'Double bond', 'Triple bond'][next], 900);
}
function removeBond(k){
  const b = bonds[k]; if(!b) return false;
  burst(atoms[b.a].p.clone().add(atoms[b.b].p).multiplyScalar(0.5), 0xc9d1e8, 14, 2, 0.4, 0.18);
  bonds.splice(k, 1); SFX.del(); buzz(12);
}

// Bond a freshly placed atom to neighbors closer than 1.2 × the sum of covalent radii,
// nearest first, within valence. Skip a bond that would close a 3- or 4-membered ring with
// a bond just made: at 1 Å spacing, atoms two or three bonds apart can sit within bonding
// distance. (Small rings can still be closed on purpose with the Bond tool.)
function withinBonds(start, target, maxSteps){
  let frontier = [start]; const seen = new Set([start]);
  for(let step = 0; step < maxSteps; step++){
    const next = [];
    for(const u of frontier) for(const v of neighbors(u)){
      if(v === target) return true;
      if(!seen.has(v)){ seen.add(v); next.push(v); }
    }
    frontier = next;
  }
  return false;
}
const PLACE_DIST = 1.0;
function perceiveFor(j){
  const pj = atoms[j].p, rj = EL[atoms[j].el].r, made = [];
  const cands = atoms.map((a, i) => ({i, d: a.p.distanceTo(pj), cut: 1.2 * (EL[a.el].r + rj)}))
    .filter(c => c.i !== j && c.d < c.cut).sort((x, y) => x.d - y.d);
  for(const c of cands){
    if(freeVal(j) < 1) break;
    if(freeVal(c.i) < 1) continue;
    if(made.some(m => withinBonds(m, c.i, 2))) continue;
    bonds.push({a: c.i, b: j, o: 1}); made.push(c.i);
  }
  return made.length;
}
function minDistTo(p, skip = -1){
  let m = Infinity; atoms.forEach((a, i) => { if(i !== skip) m = Math.min(m, a.p.distanceTo(p)); }); return m;
}
// Element button: drop a new atom near the molecule.
function placeNew(el){
  if(el !== 'H' && heavyCount() >= MAX_HEAVY) return fail(`Max ${MAX_HEAVY} heavy atoms`);
  if(atoms.length >= 150) return fail('That\'s a lot of atoms! Max 150');
  let pos;
  if(!atoms.length) pos = new THREE.Vector3();
  else if(atoms.length === 1){
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);  // to the right on screen
    pos = atoms[0].p.clone().addScaledVector(right, PLACE_DIST);
  } else {
    let anchor = -1;
    for(let i = atoms.length - 1; i >= 0; i--) if(freeVal(i) > 0){ anchor = i; break; }
    let best = null, bestGap = -1;
    if(anchor >= 0){
      for(let t = 0; t < 48; t++){
        const p = atoms[anchor].p.clone().addScaledVector(newDir(anchor, t ? 0.1 + 0.03 * t : 0.05), PLACE_DIST);
        const gap = minDistTo(p, anchor);
        if(gap > bestGap){ bestGap = gap; best = p; }
        if(gap > 1.9) break;  // clear of everything except the anchor: no accidental extra bonds
      }
    }
    if(!best || bestGap < 0.95){  // nothing free or too crowded: open space next to the molecule
      const c = centroid(), R = Math.max(...atoms.map(a => a.p.distanceTo(c)));
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      best = null; bestGap = -1;
      for(let t = 0; t < 32; t++){
        // directions in the screen plane, favoring left/right so new atoms stay visible above the toolbar
        const ang = (t / 32) * Math.PI * 2;
        const d = right.clone().multiplyScalar(Math.cos(ang)).addScaledVector(up, 0.6 * Math.sin(ang)).normalize();
        const p = c.clone().addScaledVector(d, R + 1.2);
        const gap = minDistTo(p);
        if(gap > bestGap){ bestGap = gap; best = p; }
      }
    }
    pos = best;
  }
  const j = addAtom(el, pos);
  const nb = atoms.length > 1 ? perceiveFor(j) : 0;
  SFX.pop(el); buzz(10); burst(atoms[j].p, EL[el].c, 18, 2.5, 0.5, 0.22);
  if(atoms.length > 1 && !nb) toast('Placed but not bonded — drag it closer (✋ Move) or connect with 🔗 Bond', 2600);
}
function deleteAtom(i){
  focusAtom = null;
  const rm = new Set([i]);
  if(atoms[i].el !== 'H') neighbors(i).forEach(j => { if(atoms[j].el === 'H') rm.add(j); });
  burst(atoms[i].p, EL[atoms[i].el].c, 22, 3, 0.5, 0.25);
  const map = [], na = [];
  atoms.forEach((a,k) => { if(rm.has(k)) map[k] = -1; else { map[k] = na.length; na.push(a); } });
  bonds = bonds.filter(b => map[b.a] >= 0 && map[b.b] >= 0).map(b => ({a:map[b.a], b:map[b.b], o:b.o}));
  atoms = na; SFX.del(); buzz(15);
}
function fillH(){
  let added = 0;
  const n = atoms.length;
  for(let i=0;i<n;i++){
    if(atoms[i].el === 'H') continue;
    let f = freeVal(i);
    while(f-- > 0){
      const d = newDir(i, 0.2);
      const j = addAtom('H', atoms[i].p.clone().addScaledVector(d, EL[atoms[i].el].r + EL.H.r));
      bonds.push({a:i, b:j, o:1}); added++;
    }
  }
  return added;
}
function connected(){
  if(!atoms.length) return false;
  const vis = new Set([0]), st = [0];
  while(st.length){ const i = st.pop(); for(const j of neighbors(i)) if(!vis.has(j)){ vis.add(j); st.push(j); } }
  return vis.size === atoms.length;
}
function centroid(){
  const c = new THREE.Vector3(); atoms.forEach(a => c.add(a.p));
  return atoms.length ? c.multiplyScalar(1/atoms.length) : c;
}
function formula(){
  const cnt = {}; atoms.forEach(a => cnt[a.el] = (cnt[a.el]||0) + 1);
  // Hill order: C, then H, then A-Z; without carbon everything is A-Z (FHO, H2O, H3N)
  const rank = k => cnt.C ? (k === 'C' ? 0 : k === 'H' ? 1 : 2) : 2;
  const keys = Object.keys(cnt).sort((a,b) => rank(a) - rank(b) || a.localeCompare(b));
  return keys.map(k => k + (cnt[k] > 1 ? cnt[k] : '')).join('');
}

/* ================= undo / persistence ================= */
// How the current molecule was made decides which points it can earn:
// 'hand' (built in 3D) > 'xyz' (coordinates edited) > 'example' (loaded from Learn).
let inputMethod = 'hand';
const METHOD_RANK = {hand:0, xyz:1, example:2};
function taint(m){ if(METHOD_RANK[m] > METHOD_RANK[inputMethod]) inputMethod = m; }
const serialize = () => JSON.stringify({a:atoms.map(a => [a.el, a.p.x, a.p.y, a.p.z]), b:bonds.map(b => [b.a, b.b, b.o]), m:inputMethod});
function restore(s){
  try{
    const d = JSON.parse(s);
    atoms = d.a.filter(([el]) => EL[el]).map(([el,x,y,z]) => ({el, p:new THREE.Vector3(x,y,z)}));
    bonds = d.a.length === atoms.length ? d.b.map(([a,b,o]) => ({a, b, o})) : [];
    inputMethod = d.m || 'hand';
  }catch{ atoms = []; bonds = []; inputMethod = 'hand'; }
}
function act(fn){
  if(busy) return;  // no edits while a molecule is being optimized or checked
  const snap = serialize();
  const ok = fn();
  if(ok !== false){ undoStack.push(snap); if(undoStack.length > 60) undoStack.shift(); changed(); }
}
function changed(){
  if(ghostShown && !busy) clearGhost();
  if(!atoms.length) inputMethod = 'hand';
  hoverBond = -1;
  rebuild(); updateInfo(); refreshXYZ();
  if(!puzzle) try{ localStorage.setItem('qm.work', serialize()); }catch{}  // a puzzle build isn't the player's own work
}

/* ================= toy force field + FIRE optimizer ================= */
function buildFF(){
  const n = atoms.length;
  const bl = bonds.map(b => [b.a, b.b, (EL[atoms[b.a].el].r + EL[atoms[b.b].el].r) * ORDER[b.o]]);
  const ang = [];
  for(let j=0;j<n;j++){
    const nb = neighbors(j), c0 = hybCos(j);
    for(let x=0;x<nb.length;x++) for(let y=x+1;y<nb.length;y++) ang.push([nb[x], j, nb[y], c0]);
  }
  const key = (i,k) => i < k ? i*4096 + k : k*4096 + i, ex = new Set();
  bl.forEach(([a,b]) => ex.add(key(a,b))); ang.forEach(([i,,k]) => ex.add(key(i,k)));
  const nbp = [];
  for(let i=0;i<n;i++) for(let j=i+1;j<n;j++){
    if(ex.has(key(i,j))) continue;
    const hi = atoms[i].el === 'H', hj = atoms[j].el === 'H';
    nbp.push([i, j, hi && hj ? 2.0 : (hi || hj) ? 2.4 : 2.9]);
  }
  return {n, bl, ang, nbp};
}
function egrad(ff, x, g){
  g.fill(0); let E = 0;
  for(const [a,b,r0] of ff.bl){
    const dx=x[3*a]-x[3*b], dy=x[3*a+1]-x[3*b+1], dz=x[3*a+2]-x[3*b+2];
    const r = Math.sqrt(dx*dx+dy*dy+dz*dz) || 1e-9, d = r - r0;
    E += KB*d*d; const f = 2*KB*d/r;
    g[3*a]+=f*dx; g[3*a+1]+=f*dy; g[3*a+2]+=f*dz; g[3*b]-=f*dx; g[3*b+1]-=f*dy; g[3*b+2]-=f*dz;
  }
  for(const [i,j,k,c0] of ff.ang){
    const ax=x[3*i]-x[3*j], ay=x[3*i+1]-x[3*j+1], az=x[3*i+2]-x[3*j+2];
    const bx=x[3*k]-x[3*j], by=x[3*k+1]-x[3*j+1], bz=x[3*k+2]-x[3*j+2];
    const la = Math.sqrt(ax*ax+ay*ay+az*az) || 1e-9, lb = Math.sqrt(bx*bx+by*by+bz*bz) || 1e-9;
    const c = (ax*bx+ay*by+az*bz)/(la*lb), d = c - c0;
    E += KA*d*d; const f = 2*KA*d, iab = 1/(la*lb), ia2 = c/(la*la), ib2 = c/(lb*lb);
    const gix=f*(bx*iab-ax*ia2), giy=f*(by*iab-ay*ia2), giz=f*(bz*iab-az*ia2);
    const gkx=f*(ax*iab-bx*ib2), gky=f*(ay*iab-by*ib2), gkz=f*(az*iab-bz*ib2);
    g[3*i]+=gix; g[3*i+1]+=giy; g[3*i+2]+=giz; g[3*k]+=gkx; g[3*k+1]+=gky; g[3*k+2]+=gkz;
    g[3*j]-=gix+gkx; g[3*j+1]-=giy+gky; g[3*j+2]-=giz+gkz;
  }
  for(const [i,j,d0] of ff.nbp){
    const dx=x[3*i]-x[3*j], dy=x[3*i+1]-x[3*j+1], dz=x[3*i+2]-x[3*j+2], r2 = dx*dx+dy*dy+dz*dz;
    if(r2 >= d0*d0) continue;
    const r = Math.sqrt(r2) || 1e-9, d = d0 - r;
    E += KR*d*d; const f = -2*KR*d/r;
    g[3*i]+=f*dx; g[3*i+1]+=f*dy; g[3*i+2]+=f*dz; g[3*j]-=f*dx; g[3*j+1]-=f*dy; g[3*j+2]-=f*dz;
  }
  return E;
}
function fire(ff, x, {mask=null, maxSteps=4000, ftol=0.02, record=null} = {}){
  const n3 = x.length, v = new Float64Array(n3), g = new Float64Array(n3);
  let dt = 0.02, alpha = 0.1, np = 0, E = 0, fmax = 0;
  for(let s=0; s<maxSteps; s++){
    E = egrad(ff, x, g);
    if(mask) for(let i=0;i<n3;i++) if(!mask[(i/3)|0]) g[i] = 0;
    fmax = 0;
    for(let a=0; a<n3; a+=3) fmax = Math.max(fmax, Math.hypot(g[a], g[a+1], g[a+2]));
    if(record && s % 4 === 0) record.push(Float64Array.from(x));
    if(fmax < ftol) break;
    let P = 0, vn = 0, fn = 0;
    for(let i=0;i<n3;i++){ P -= g[i]*v[i]; vn += v[i]*v[i]; fn += g[i]*g[i]; }
    vn = Math.sqrt(vn); fn = Math.sqrt(fn) || 1e-12;
    if(P > 0){
      for(let i=0;i<n3;i++) v[i] = (1-alpha)*v[i] - alpha*vn*g[i]/fn;
      if(++np > 5){ dt = Math.min(dt*1.1, 0.07); alpha *= 0.99; }
    } else { v.fill(0); dt = Math.max(dt*0.5, 1e-3); alpha = 0.1; np = 0; }
    for(let a=0; a<n3; a+=3){
      for(let q=0;q<3;q++) v[a+q] -= g[a+q]*dt;
      let sx = v[a]*dt, sy = v[a+1]*dt, sz = v[a+2]*dt;
      const L = Math.hypot(sx, sy, sz); if(L > 0.1){ const k = 0.1/L; sx*=k; sy*=k; sz*=k; }
      x[a]+=sx; x[a+1]+=sy; x[a+2]+=sz;
    }
    if(mask) for(let i=0;i<n3;i++) if(!mask[(i/3)|0]) v[i] = 0;
  }
  if(record) record.push(Float64Array.from(x));
  return {E, fmax, converged: fmax < ftol};
}
function sane(ff, x){
  const P = i => [x[3*i], x[3*i+1], x[3*i+2]];
  const dist = (i,j) => { const a = P(i), b = P(j); return Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]); };
  for(const [a,b,r0] of ff.bl){ const r = dist(a,b); if(r > 1.2*r0 || r < 0.8*r0) return false; }
  for(const [i,j,k] of ff.ang){
    if(atoms[i].el === 'H' || atoms[k].el === 'H') continue;
    const a = P(i), b = P(j), c = P(k);
    const u = [a[0]-b[0], a[1]-b[1], a[2]-b[2]], w = [c[0]-b[0], c[1]-b[1], c[2]-b[2]];
    const cos = (u[0]*w[0]+u[1]*w[1]+u[2]*w[2]) / (Math.hypot(...u)*Math.hypot(...w));
    if(cos > 0.643) return false;          // angle below ~50°
  }
  for(const [i,j] of ff.nbp) if(atoms[i].el !== 'H' && atoms[j].el !== 'H' && dist(i,j) < 1.6) return false;
  return true;
}

/* ================= RDKit (SMILES) ================= */
// Online, SMILES come from the server (RDKit in Python), so the page never needs
// eval-like code and can run under a strict Content-Security-Policy.
// Offline (no server), RDKit.js is loaded in the browser instead.
let RD = null;
function loadRDKit(){
  const s = document.createElement('script');
  s.src = './vendor/RDKit_minimal.js';
  s.onload = () => window.initRDKitModule({locateFile: () => './vendor/RDKit_minimal.wasm'})
    .then(m => { RD = m; updateInfo(); refreshXYZ(); }).catch(() => toast('Chemistry engine failed to load — novelty bonuses are off'));
  s.onerror = () => toast('Chemistry engine failed to load — novelty bonuses are off');
  document.head.appendChild(s);
}
const smilesCache = new Map();
let smilesTimer = 0;
const topoKey = () => atoms.map(a => a.el).join(',') + '|' + bonds.map(b => `${b.a}-${b.b}-${b.o}`).join(',');
function requestSmiles(key){
  clearTimeout(smilesTimer);
  smilesTimer = setTimeout(async () => {
    if(key !== topoKey() || !atoms.length) return;
    try{
      const r = await api('/api/smiles', {method:'POST', body:{atoms: atoms.map(a => ({el:a.el})), bonds: bonds.map(b => [b.a, b.b, b.o])}});
      if(smilesCache.size > 500) smilesCache.clear();
      smilesCache.set(key, r.smiles);
      if(key === topoKey()){ updateInfo(); refreshXYZ(); }
    }catch{}
  }, 250);
}
const p3 = n => String(n).padStart(3);
const f10 = v => v.toFixed(4).padStart(10);
function molblock(){
  const L = ['QuMol', '  QuMol          3D', ''];
  L.push(p3(atoms.length) + p3(bonds.length) + '  0  0  0  0  0  0  0  0999 V2000');
  atoms.forEach(a => L.push(f10(a.p.x) + f10(a.p.y) + f10(a.p.z) + ' ' + a.el.padEnd(3) + ' 0  0  0  0  0  0  0  0  0  0  0  0'));
  bonds.forEach(b => L.push(p3(b.a+1) + p3(b.b+1) + p3(b.o) + '  0'));
  const ch = valenceState().charge.map((q, i) => [i + 1, q]).filter(([, q]) => q);
  for(let k = 0; k < ch.length; k += 8){
    const part = ch.slice(k, k + 8);
    L.push('M  CHG' + p3(part.length) + part.map(([i, q]) => ' ' + p3(i) + ' ' + p3(q)).join(''));
  }
  L.push('M  END');
  return L.join('\n');
}
function getSmiles(){
  if(!atoms.length) return null;
  if(ONLINE){
    const key = topoKey();
    if(smilesCache.has(key)) return smilesCache.get(key);
    requestSmiles(key); return null;
  }
  if(!RD) return null;
  let mol = null;
  try{
    mol = RD.get_mol(molblock(), JSON.stringify({removeHs: true}));
    if(!mol || (mol.is_valid && !mol.is_valid())) return null;
    return mol.get_smiles();
  }catch{ return null; }
  finally{ try{ mol && mol.delete(); }catch{} }
}

/* ================= PubChem ================= */
async function pubchemIsNew(smi){
  if(pcCache[smi] !== undefined) return pcCache[smi];
  const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 9000);
  try{
    const r = await fetch('https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/smiles/cids/JSON', {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:'smiles=' + encodeURIComponent(smi), signal:ctl.signal});
    const j = await r.json().catch(() => null);
    let res = null;
    if(r.ok && j && j.IdentifierList) res = !(j.IdentifierList.CID || []).some(c => c > 0);
    else if(r.status === 404 || (j && j.Fault && /NotFound/.test(j.Fault.Code || ''))) res = true;
    if(res !== null){ pcCache[smi] = res; LS.set('qm.pubchem', pcCache); }
    return res;
  }catch{ return null; }
  finally{ clearTimeout(to); }
}

/* ================= UI ================= */
let toastT = 0;
function toast(msg, ms=1800){ const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), ms); }
function fail(msg){ toast(msg); SFX.err(); buzz([20,40,20]); return false; }
const formulaHTML = f => f.replace(/(\d+)/g, '<sub>$1</sub>');
const escapeHTML = s => s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function updateInfo(){
  const h = heavyCount();
  const info = $('info');
  if(atoms.length){
    const smi = getSmiles();
    info.innerHTML = `<b>${formulaHTML(formula())}</b>${smi ? ' · ' + escapeHTML(smi) : ''} · ${h}/${MAX_HEAVY}`;
  } else info.textContent = `Tap to place an atom · 0/${MAX_HEAVY}`;
  $('total').textContent = `${total.toLocaleString()} ⭐`;
}

// element buttons
for(const e of Object.keys(EL)){
  const b = document.createElement('button');
  b.className = 'el' + (e === element ? ' on' : ''); b.textContent = e;
  b.dataset.tip = `${EL[e].name} (forms ${EL[e].val} bond${EL[e].val > 1 ? 's' : ''}): click to add one. It appears 1 Å from the newest atom with a free bond and bonds automatically if close enough. Or tap an atom to grow ${e} from it.`;
  b.setAttribute('aria-label', b.dataset.tip);
  const hex = '#' + EL[e].c.toString(16).padStart(6,'0');
  b.style.background = hex; b.style.color = e === 'H' || e === 'F' ? '#111' : '#fff';
  b.onclick = () => {
    unlockAudio(); element = e;
    document.querySelectorAll('.el').forEach(x => x.classList.toggle('on', x === b));
    if(mode !== 'add') setMode('add');
    if(busy) return;
    act(() => { bondFirst = null; return placeNew(e); });
  };
  $('els').appendChild(b);
  if(e === 'H') $('els').appendChild($('hplus'));  // H+ sits right after H, with a gap before C
}
function setMode(m){
  mode = m; bondFirst = null;
  document.querySelectorAll('.mode').forEach(x => x.classList.toggle('on', x.dataset.mode === m));
  rebuild();
}
document.querySelectorAll('.mode').forEach(b => b.onclick = () => { unlockAudio(); setMode(b.dataset.mode); SFX.tick(1); });
$('hplus').onclick = () => { unlockAudio(); act(() => { const n = fillH(); if(!n) return fail('No open valences to fill'); SFX.chime(); }); };
$('undo').onclick = () => { unlockAudio(); if(busy) return; if(!undoStack.length) return fail('Nothing to undo'); restore(undoStack.pop()); bondFirst = null; SFX.tick(2); changed(); };
$('clear').onclick = () => { unlockAudio(); if(!atoms.length) return; act(() => { atoms.forEach(a => burst(a.p, EL[a.el].c, 8, 3, 0.5)); atoms = []; bonds = []; SFX.del(); }); };
$('submit').onclick = () => { unlockAudio(); submit(); };
$('mute').textContent = muted ? '🔇' : '🔊';
$('measure').classList.toggle('on', measureOn);
$('measure').onclick = () => {
  unlockAudio(); measureOn = !measureOn; LS.set('qm.measure', measureOn);
  $('measure').classList.toggle('on', measureOn); SFX.tick();
  if(measureOn) toast('Tap or drag an atom to see its bond angles');
};
$('mute').onclick = () => { unlockAudio(); muted = !muted; LS.set('qm.muted', muted); $('mute').textContent = muted ? '🔇' : '🔊'; };
$('help').onclick = () => { unlockAudio(); showHelp(); };
$('total').onclick = () => { unlockAudio(); showCollection(); };
$('lb').onclick = () => { unlockAudio(); showLeaderboard(); };
$('puzzleBtn').onclick = () => { unlockAudio(); SFX.tick(); showPuzzles(); };
$('pzExit').onclick = () => { unlockAudio(); exitPuzzle(); };

/* ================= formula / XYZ panel ================= */
let xyzOpen = LS.get('qm.xyzOpen', innerWidth > 640);
let xyzTimer = 0;
function setXYZOpen(open, remember = true){
  xyzOpen = open; if(remember) LS.set('qm.xyzOpen', open);
  $('xyzPanel').classList.toggle('hidden', !open);
  $('xyzBtn').classList.toggle('on', open);
  if(open) refreshXYZ(true);
}
function toXYZ(){
  const f = (v) => v.toFixed(4).padStart(10);
  return `${atoms.length}\n${atoms.length ? formula() : 'empty'}\n` +
    atoms.map(a => `${a.el.padEnd(2)} ${f(a.p.x)} ${f(a.p.y)} ${f(a.p.z)}`).join('\n');
}
function refreshXYZ(force=false){
  if(!xyzOpen) return;
  $('pFormula').innerHTML = atoms.length ? formulaHTML(formula()) : '—';
  $('pSmiles').textContent = atoms.length ? (getSmiles() || '') : 'Nothing built yet';
  const ta = $('xyzText');
  if(force || document.activeElement !== ta){ ta.value = toXYZ(); ta.classList.remove('bad'); }
}
function xyzMsg(text, cls=''){ const m = $('xyzMsg'); m.textContent = text; m.className = 'pmsg ' + cls; }
function parseXYZ(text){
  let lines = text.split('\n').map(l => l.trim());
  while(lines.length && !lines[0]) lines.shift();
  if(lines.length && /^\d+$/.test(lines[0])) lines = lines.slice(2);  // header: count + comment
  const out = [];
  for(const [k, l] of lines.entries()){
    if(!l || l.startsWith('#')) continue;
    const t = l.split(/[\s,]+/);
    if(t.length < 4) throw new Error(`Line "${l}": need an element and x y z`);
    const el = t[0][0].toUpperCase() + t[0].slice(1).toLowerCase();
    if(!EL[el]) throw new Error(`Unknown element "${t[0]}". Allowed: ${Object.keys(EL).join(' ')}`);
    const xyz = t.slice(1, 4).map(Number);
    if(xyz.some(v => !Number.isFinite(v) || Math.abs(v) > 500)) throw new Error(`Line "${l}": coordinates must be numbers`);
    out.push({el, p: new THREE.Vector3(...xyz)});
  }
  if(out.filter(a => a.el !== 'H').length > MAX_HEAVY) throw new Error(`Max ${MAX_HEAVY} heavy atoms`);
  return out;
}
// Guess bonds from distances, then raise bond orders where both atoms still have free valence.
function perceiveBonds(list){
  const n = list.length, cand = [], fv = list.map(a => EL[a.el].val), out = [];
  for(let i=0;i<n;i++) for(let j=i+1;j<n;j++){
    const r0 = EL[list[i].el].r + EL[list[j].el].r, d = list[i].p.distanceTo(list[j].p);
    if(d > 0.4 && d < 1.25*r0) cand.push({a:i, b:j, k:d/r0});
  }
  cand.sort((x,y) => x.k - y.k);
  for(const c of cand) if(fv[c.a] > 0 && fv[c.b] > 0){ out.push({a:c.a, b:c.b, o:1, k:c.k}); fv[c.a]--; fv[c.b]--; }
  for(let pass=0; pass<2; pass++)
    for(const b of out) if(b.o < 3 && fv[b.a] > 0 && fv[b.b] > 0 && b.k < 0.97){ b.o++; fv[b.a]--; fv[b.b]--; }
  // a very short bond (triple-bond length) may use the charged valence: C≡O as ⁻C≡O⁺
  const extra = list.map(a => maxBonds(a.el) - EL[a.el].val);
  for(const b of out) if(b.o < 3 && b.k < 0.84 && fv[b.a] + extra[b.a] > 0 && fv[b.b] + extra[b.b] > 0){
    for(const x of [b.a, b.b]){ if(fv[x] > 0) fv[x]--; else extra[x]--; }
    b.o++;
  }
  return out.map(({a,b,o}) => ({a,b,o}));
}
function applyXYZ(){
  const ta = $('xyzText');
  let list;
  try{ list = parseXYZ(ta.value); }
  catch(e){ ta.classList.add('bad'); xyzMsg(e.message, 'err'); return false; }
  ta.classList.remove('bad');
  const sameEls = list.length === atoms.length && list.every((a,i) => a.el === atoms[i].el);
  if(sameEls && list.every((a,i) => a.p.distanceTo(atoms[i].p) < 1e-5)){ xyzMsg('Up to date.'); return; }
  if(busy){ xyzMsg('Not applied: wait for the optimization to finish.', 'err'); return false; }
  act(() => {
    if(sameEls) list.forEach((a,i) => atoms[i].p.copy(a.p));
    else {
      const now = performance.now();
      atoms = list.map((a,i) => ({el:a.el, p:a.p, born: i >= atoms.length || atoms[i].el !== a.el ? now : undefined}));
      bonds = perceiveBonds(atoms);
    }
    taint('xyz'); bondFirst = null;
  });
  xyzMsg(sameEls ? 'Coordinates applied ✓' : `Applied ✓ — bonds guessed from distances (${bonds.length}). Fix any with 🔗 Bond.`, 'ok');
  SFX.tick(2);
}
$('xyzBtn').onclick = () => { unlockAudio(); setXYZOpen(!xyzOpen); SFX.tick(); };
$('xyzClose').onclick = () => { setXYZOpen(false); SFX.tick(); };
$('xyzText').addEventListener('input', () => { clearTimeout(xyzTimer); xyzTimer = setTimeout(applyXYZ, 700); });
$('xyzText').addEventListener('blur', () => {
  clearTimeout(xyzTimer);
  const ok = applyXYZ(); refreshXYZ(true);
  if(ok === false) xyzMsg('That edit had an error, so the panel went back to the current molecule.', 'err');
});
$('xyzText').addEventListener('keydown', e => e.stopPropagation());

/* ================= example molecules (Learn → "Show me") ================= */
const t3 = 0.629;  // 1.09 Å / √3, tetrahedral C–H components
const EXAMPLES = {
  methane:{name:'Methane, CH₄', say:'Carbon: 4 single bonds point to the corners of a tetrahedron, 109.5° apart.',
    atoms:[['C',0,0,0],['H',t3,t3,t3],['H',-t3,-t3,t3],['H',-t3,t3,-t3],['H',t3,-t3,-t3]], bonds:[[0,1,1],[0,2,1],[0,3,1],[0,4,1]]},
  ammonia:{name:'Ammonia, NH₃', say:'Nitrogen: 3 bonds + 1 lone pair. The lone pair pushes the H atoms down into a pyramid (~107°).',
    atoms:[['N',0,0,0.116],['H',0,0.939,-0.271],['H',0.813,-0.469,-0.271],['H',-0.813,-0.469,-0.271]], bonds:[[0,1,1],[0,2,1],[0,3,1]]},
  water:{name:'Water, H₂O', say:'Oxygen: 2 bonds + 2 lone pairs → a bent shape (104.5°). That bend makes water polar.',
    atoms:[['O',0,0,0],['H',0.757,0.586,0],['H',-0.757,0.586,0]], bonds:[[0,1,1],[0,2,1]]},
  h2s:{name:'Hydrogen sulfide, H₂S', say:'Sulfur bonds like oxygen (2 bonds) but its bonds are longer (1.34 Å) and the angle is tighter (92°).',
    atoms:[['S',0,0,0],['H',0.961,0.927,0],['H',-0.961,0.927,0]], bonds:[[0,1,1],[0,2,1]]},
  fluoromethane:{name:'Fluoromethane, CH₃F', say:'Fluorine makes exactly one bond and hoards electrons: the C–F bond is one of the strongest single bonds.',
    atoms:[['C',0,0,0],['F',0,0,1.38],['H',1.027,0,-0.363],['H',-0.513,0.889,-0.363],['H',-0.513,-0.889,-0.363]], bonds:[[0,1,1],[0,2,1],[0,3,1],[0,4,1]]},
  ethane:{name:'Ethane, C₂H₆', say:'C–C single bond, 1.54 Å. Single bonds can spin freely.',
    atoms:[['C',0,0,0.765],['C',0,0,-0.765],['H',1.027,0,1.128],['H',-0.513,0.889,1.128],['H',-0.513,-0.889,1.128],
           ['H',-1.027,0,-1.128],['H',0.513,0.889,-1.128],['H',0.513,-0.889,-1.128]],
    bonds:[[0,1,1],[0,2,1],[0,3,1],[0,4,1],[1,5,1],[1,6,1],[1,7,1]]},
  ethylene:{name:'Ethylene, C₂H₄', say:'C=C double bond, 1.34 Å: shorter, stronger, and it locks the molecule flat (120° angles).',
    atoms:[['C',0.667,0,0],['C',-0.667,0,0],['H',1.232,0.924,0],['H',1.232,-0.924,0],['H',-1.232,0.924,0],['H',-1.232,-0.924,0]],
    bonds:[[0,1,2],[0,2,1],[0,3,1],[1,4,1],[1,5,1]]},
  acetylene:{name:'Acetylene, C₂H₂', say:'C≡C triple bond, 1.20 Å: the shortest carbon bond, and the molecule is a straight line (180°).',
    atoms:[['C',0,0,0.601],['C',0,0,-0.601],['H',0,0,1.663],['H',0,0,-1.663]], bonds:[[0,1,3],[0,2,1],[1,3,1]]},
  formaldehyde:{name:'Formaldehyde, CH₂O', say:'A C=O double bond makes carbon trigonal planar: three groups, 120° apart, all flat.',
    atoms:[['C',0,0,0],['O',0,0,1.205],['H',0.943,0,-0.587],['H',-0.943,0,-0.587]], bonds:[[0,1,2],[0,2,1],[0,3,1]]},
  co:{name:'Carbon monoxide, CO', say:'A C≡O triple bond gives oxygen a 3rd bond, so it carries a + charge and carbon a − (⁻C≡O⁺). QuMol assigns these formal charges for you.',
    atoms:[['C',0,0,0],['O',1.128,0,0]], bonds:[[0,1,3]]},
  methyl:{name:'Methyl radical, •CH₃', say:'Carbon with only 3 bonds keeps one unpaired electron: a radical. Build it and choose "Build as a radical".',
    atoms:[['C',0,0,0],['H',1.08,0,0],['H',-0.54,0.935,0],['H',-0.54,-0.935,0]], bonds:[[0,1,1],[0,2,1],[0,3,1]]},
  co2:{name:'Carbon dioxide, CO₂', say:'Two C=O double bonds use all 4 of carbon\'s bonds: two groups → a straight line.',
    atoms:[['C',0,0,0],['O',1.16,0,0],['O',-1.16,0,0]], bonds:[[0,1,2],[0,2,2]]},
  benzene:{name:'Benzene, C₆H₆', say:'A flat ring of 6 carbons with alternating double bonds. Rings: close a chain with 🔗 Bond.',
    atoms:[...Array.from({length:6}, (_,k) => ['C', 1.397*Math.cos(k*Math.PI/3), 1.397*Math.sin(k*Math.PI/3), 0]),
           ...Array.from({length:6}, (_,k) => ['H', 2.48*Math.cos(k*Math.PI/3), 2.48*Math.sin(k*Math.PI/3), 0])],
    bonds:[[0,1,2],[1,2,1],[2,3,2],[3,4,1],[4,5,2],[5,0,1],[0,6,1],[1,7,1],[2,8,1],[3,9,1],[4,10,1],[5,11,1]]},
};
function loadExample(key){
  if(puzzle) return fail('Examples are off during a puzzle');
  if(busy) return toast('Wait for the current molecule to finish');
  const ex = EXAMPLES[key];
  act(() => {
    const now = performance.now();
    atoms = ex.atoms.map(([el,x,y,z], i) => ({el, p:new THREE.Vector3(x,y,z), born: now + i*40}));
    bonds = ex.bonds.map(([a,b,o]) => ({a,b,o}));
    inputMethod = 'example'; bondFirst = null;
  });
  $('ov').classList.add('hidden');
  SFX.chime(); burst(new THREE.Vector3(), [0xff5ca8, 0x7c5cff, 0x20d3a7], 40, 4, 0.8, 0.28);
  toast(`${ex.name}: ${ex.say}`, 6000);
}

/* ================= Learn panel ================= */
const ELINFO = {
  H:{ve:1, lp:0, shape:'Always on the outside — only one bond', fact:'The lightest and most common element in the universe. Its single electron pairs with one partner and it\'s done (2 electrons is a full shell for H).', ex:'methane', len:'C–H 1.09 Å'},
  C:{ve:4, lp:0, shape:'4 singles: tetrahedral 109.5° · 1 double: flat 120° · 1 triple: linear 180°', fact:'The backbone of life. Four bonds in any combination: 4 singles, a double + 2 singles, 2 doubles, or a triple + a single. That flexibility is why there are millions of organic molecules.', ex:'methane', len:'C–C 1.54 · C=C 1.34 · C≡C 1.20 Å'},
  N:{ve:5, lp:1, shape:'Trigonal pyramid (~107°) — the lone pair pushes the bonds down', fact:'Three bonds plus one lone pair. Nitrogen is in DNA bases, proteins and most drugs; its lone pair is what makes amines basic. As N⁺ it can make 4 bonds, as in nitro groups.', ex:'ammonia', len:'C–N 1.47 · C=N 1.28 · C≡N 1.16 Å'},
  O:{ve:6, lp:2, shape:'Bent (~104.5°) — two lone pairs squeeze the bonds together', fact:'Two bonds plus two lone pairs. Oxygen is greedy for electrons, so its bonds are polar — that\'s why water is such a good solvent. As O⁺ it can take a 3rd bond, as in carbon monoxide ⁻C≡O⁺.', ex:'water', len:'C–O 1.43 · C=O 1.21 Å'},
  S:{ve:6, lp:2, shape:'Bent (~92–100°)', fact:'Oxygen\'s bigger cousin: same 6 valence electrons, so it also makes 2 bonds here, but they are longer and softer. Sulfur can also make 4 or 6 bonds without any charge, as in DMSO or sulfuric acid.', ex:'h2s', len:'C–S 1.82 Å'},
  F:{ve:7, lp:3, shape:'One bond, three lone pairs — always on the outside', fact:'One electron short of a full octet, so exactly one bond. Fluorine is the most electronegative element: it pulls electrons harder than anything else.', ex:'fluoromethane', len:'C–F 1.35 Å'},
};
function lewisSVG(el){
  const n = ELINFO[el].ve, c = '#' + EL[el].c.toString(16).padStart(6,'0');
  const side = [[0,-1],[1,0],[0,1],[-1,0]], count = [0,0,0,0];
  for(let i=0;i<n;i++) count[i < 4 ? i : i-4]++;  // one per side first, then pair up
  if(el === 'H') count.splice(0, 4, 0, 1, 0, 0);
  let dots = '';
  side.forEach(([sx,sy], s) => {
    const k = count[s];
    for(let j=0;j<k;j++){
      const off = k === 2 ? (j ? 7 : -7) : 0;
      const x = 46 + sx*30 + (sy ? off : 0), y = 46 + sy*30 + (sx ? off : 0);
      dots += `<circle cx="${x}" cy="${y}" r="4.5" fill="#ffd166"><animate attributeName="r" values="4.5;6;4.5" dur="1.6s" begin="${(s*0.2+j*0.1).toFixed(1)}s" repeatCount="indefinite"/></circle>`;
    }
  });
  return `<svg class="lewis" viewBox="0 0 92 92"><circle cx="46" cy="46" r="20" fill="${c}"/><text x="46" y="53" text-anchor="middle" font-size="20" font-weight="800" fill="${el==='H'||el==='F'?'#111':'#fff'}">${el}</text>${dots}</svg>`;
}
let learnEl = 'C', learnTab = 'elements';
const quizState = {streak:0, best:Math.max(0, Math.floor(Number(LS.get('qm.quizBest', 0))) || 0), order:[], i:0};
const QUIZ = [
  {q:'How many bonds does nitrogen usually form?', a:['1','2','3','4'], c:2, e:'Nitrogen has 5 valence electrons. 3 bonds + 1 lone pair = a full octet.'},
  {q:'Which bond is the shortest?', a:['C–C','C=C','C≡C'], c:2, e:'More shared electrons pull atoms closer: C≡C 1.20 Å < C=C 1.34 Å < C–C 1.54 Å.'},
  {q:'What shape is methane (CH₄)?', a:['Flat square','Tetrahedral','Linear','Bent'], c:1, e:'Four bonds spread as far apart as possible in 3D: a tetrahedron, 109.5° apart.'},
  {q:'Why is water bent and not straight?', a:['Hydrogen is heavy','Oxygen\'s two lone pairs push the bonds together','The bonds are double','It isn\'t — water is straight'], c:1, e:'Lone pairs take up space too. O has 2 bonds + 2 lone pairs, so the H–O–H angle closes to 104.5°.'},
  {q:'How many lone pairs does fluorine have in CH₃F?', a:['0','1','2','3'], c:3, e:'F has 7 valence electrons: 1 goes into the bond, the other 6 form 3 lone pairs.'},
  {q:'Carbon makes one double bond. How many single bonds can it still make?', a:['1','2','3','4'], c:1, e:'A double bond uses 2 of carbon\'s 4 bonds, leaving 2 singles — like in ethylene or formaldehyde.'},
  {q:'What is the H–C–H angle in ethylene (C₂H₄)?', a:['90°','109.5°','About 120°','180°'], c:2, e:'Three groups around each carbon (a double bond counts as one group) → flat, about 120°.'},
  {q:'What shape is CO₂?', a:['Bent','Linear','Tetrahedral','Pyramidal'], c:1, e:'Carbon\'s two double bonds are the only two groups, and they point in opposite directions: 180°.'},
  {q:'Which element can only ever be on the outside of a molecule?', a:['Carbon','Oxygen','Hydrogen','Nitrogen'], c:2, e:'Hydrogen makes exactly one bond, so it can never connect two other atoms. (Fluorine is the same!)'},
  {q:'What does the H+ button do?', a:['Adds a proton (positive charge)','Adds H atoms to every free bond until each atom\'s valence is full','Doubles every bond','Removes hydrogens'], c:1, e:'It saturates your molecule: C gets up to 4 bonds, N 3, O and S 2 — the rest are filled with H.'},
  {q:'How many valence electrons does oxygen have?', a:['2','4','6','8'], c:2, e:'O has 6. It needs 2 more for an octet, which is why it makes 2 bonds.'},
  {q:'Why is carbon monoxide drawn as ⁻C≡O⁺?', a:['It is an ion','Oxygen\'s third bond makes it +, and carbon (only 3 bonds) becomes −','Carbon is more electronegative','Triple bonds are always charged'], c:1, e:'Formal charges are bookkeeping: O with 3 bonds is +1, C with 3 bonds and a lone pair is −1. They cancel, so CO is neutral overall.'},
  {q:'Benzene\'s ring is…', a:['Puckered like a chair','Perfectly flat','A straight line','Tetrahedral'], c:1, e:'All six carbons are trigonal planar (120°), so the whole ring is flat.'},
];
function showLearn(tab = learnTab){
  learnTab = tab;
  const card = openCard(); card.classList.add('wide');
  card.innerHTML = '<h2>🏫 Learn chemistry</h2>';
  const tabs = document.createElement('div'); tabs.className = 'tabs';
  for(const [k, label] of [['elements','⚛️ Elements'], ['shapes','📐 Bonds & shapes'], ['quiz','❓ Quiz']]){
    const b = document.createElement('button'); b.textContent = label; b.className = k === tab ? 'on' : '';
    b.onclick = () => { SFX.tick(); showLearn(k); }; tabs.appendChild(b);
  }
  card.appendChild(tabs);
  const body = document.createElement('div'); card.appendChild(body);
  ({elements: learnElements, shapes: learnShapes, quiz: learnQuiz})[tab](body);
  closeBtn(card, 'Back to building');
}
function learnElements(body){
  body.innerHTML = `<p style="margin-top:0">Atoms bond to fill their outer shell — usually <b>8 electrons</b> (the <b>octet rule</b>; hydrogen only needs 2). Each bond shares 2 electrons, so <b>bonds = 8 − valence electrons</b>. Tap an element:</p>`;
  const grid = document.createElement('div'); grid.className = 'lgrid';
  for(const e of Object.keys(EL)){
    const b = document.createElement('button'); b.textContent = e; b.className = e === learnEl ? 'on' : '';
    b.style.background = '#' + EL[e].c.toString(16).padStart(6,'0'); b.style.color = e==='H'||e==='F' ? '#111' : '#fff';
    b.onclick = () => { learnEl = e; SFX.pop(e); showLearn('elements'); };
    grid.appendChild(b);
  }
  body.appendChild(grid);
  const e = learnEl, info = ELINFO[e], val = EL[e].val;
  const slots = '<span></span>'.repeat(val) + '<span class="lp"></span>'.repeat(info.lp);
  const c = document.createElement('div'); c.className = 'ecard';
  c.innerHTML = `<div class="row2">${lewisSVG(e)}<div><h3>${EL[e].name}</h3>
      <div class="slots">${slots}</div>
      <div class="legend"><span style="color:var(--acc2)">■</span> bonds (${val}) &nbsp; <span style="color:#ffd166">■</span> lone pairs (${info.lp})</div></div></div>
    <div class="facts" style="margin-top:8px">
      <b>Valence e⁻</b><span>${info.ve} → needs ${e === 'H' ? 1 : 8 - info.ve} more → <b style="color:var(--acc2)">${val} bond${val>1?'s':''}</b></span>
      <b>Shape</b><span>${info.shape}</span>
      <b>Bond lengths</b><span>${info.len}</span>
    </div>
    <p style="font-size:14px;line-height:1.45">${info.fact}</p>`;
  const tryB = document.createElement('button'); tryB.className = 'try';
  tryB.textContent = `Show me ${EXAMPLES[info.ex].name} in 3D ✨`;
  tryB.onclick = () => loadExample(info.ex);
  c.appendChild(tryB);
  body.appendChild(c);
}
function learnShapes(body){
  body.innerHTML = `<p style="margin-top:0">Bonds and lone pairs repel each other, so they spread out as far as they can. Count the <b>groups</b> around an atom (a double or triple bond counts as one group) and you can predict its shape. Shorter, stronger bonds come from sharing more electrons.</p>`;
  const rows = [
    ['109.5°', 'Tetrahedral', '4 single bonds around carbon.', 'methane'],
    ['~107°', 'Pyramidal', '3 bonds + 1 lone pair on nitrogen.', 'ammonia'],
    ['104.5°', 'Bent', '2 bonds + 2 lone pairs on oxygen.', 'water'],
    ['120°', 'Trigonal planar', 'A double bond + 2 singles: flat.', 'formaldehyde'],
    ['180°', 'Linear', 'Two groups on opposite sides.', 'co2'],
    ['C–C', 'Single bond', '1.54 Å, free to rotate.', 'ethane'],
    ['C=C', 'Double bond', '1.34 Å, locked flat.', 'ethylene'],
    ['C≡C', 'Triple bond', '1.20 Å, straight line.', 'acetylene'],
    ['⬡', 'Ring', 'Close a chain with 🔗 Bond. Small rings (3–4 atoms) are strained.', 'benzene'],
    ['⁻C≡O⁺', 'Formal charges', 'O can make a 3rd bond (N a 4th) as a + ion when a neighbor takes the −. QuMol does this automatically.', 'co'],
    ['•', 'Radicals', 'Leave a bond empty for an unpaired electron (up to 2 per molecule).', 'methyl'],
  ];
  for(const [ang, title, text, ex] of rows){
    const r = document.createElement('div'); r.className = 'shape';
    r.innerHTML = `<div class="ang">${ang}</div><p><b>${title}</b> — ${text}</p>`;
    const b = document.createElement('button'); b.textContent = 'Show me';
    b.onclick = () => loadExample(ex); r.appendChild(b); body.appendChild(r);
  }
}
function learnQuiz(body){
  const s = quizState;
  if(!s.order.length || s.i >= s.order.length){ s.order = QUIZ.map((_,i) => i).sort(() => Math.random() - 0.5); s.i = 0; }
  const q = QUIZ[s.order[s.i]];
  body.innerHTML = `<div class="streak">🔥 Streak ${s.streak} · Best ${s.best} · Question ${s.i+1}/${QUIZ.length}</div><div class="quizq">${q.q}</div>`;
  const opts = document.createElement('div'); opts.className = 'quizopts'; body.appendChild(opts);
  q.a.forEach((txt, k) => {
    const b = document.createElement('button'); b.textContent = txt; opts.appendChild(b);
    b.onclick = () => {
      opts.querySelectorAll('button').forEach((x, j) => { x.disabled = true; if(j === q.c) x.classList.add('right'); });
      const ok = k === q.c;
      if(ok){ s.streak++; if(s.streak > s.best){ s.best = s.streak; LS.set('qm.quizBest', s.best); } SFX.chime(); buzz(30); }
      else { b.classList.add('wrong'); s.streak = 0; SFX.err(); buzz([20,40,20]); }
      const e = document.createElement('div'); e.className = 'qexp';
      e.innerHTML = `<b>${ok ? (s.streak >= 3 ? `🔥 ${s.streak} in a row!` : '✅ Correct!') : '❌ Not quite.'}</b> ${q.e}`;
      const next = document.createElement('button'); next.textContent = 'Next question →'; next.style.marginTop = '10px'; next.style.width = '100%';
      next.onclick = () => { s.i++; SFX.tick(); showLearn('quiz'); };
      body.append(e, next);
      body.querySelector('.streak').textContent = `🔥 Streak ${s.streak} · Best ${s.best} · Question ${s.i+1}/${QUIZ.length}`;
    };
  });
}
$('learn').onclick = () => { unlockAudio(); SFX.tick(); showLearn(); };

/* ================= pointer input ================= */
const pointers = new Map();
let gesture = null, dragSnap = null;
const raycaster = new THREE.Raycaster(), dragPlane = new THREE.Plane(), tmpV = new THREE.Vector3();
function pick(cx, cy){
  const rect = canvas.getBoundingClientRect();
  let best = -1, bd = Infinity;
  atoms.forEach((a, i) => {
    const v = a.p.clone().add(world.position).project(camera);
    if(v.z > 1) return;
    const sx = (v.x+1)/2*rect.width + rect.left, sy = (1-v.y)/2*rect.height + rect.top;
    const d = Math.hypot(sx - cx, sy - cy);
    if(d < bd){ bd = d; best = i; }
  });
  return bd < 32 ? best : -1;
}
function toScreen(p, rect){
  const v = p.clone().add(world.position).project(camera);
  return {x: (v.x+1)/2*rect.width + rect.left, y: (1-v.y)/2*rect.height + rect.top, z: v.z};
}
// Nearest atom and nearest bond under the pointer; a bond wins when the tap is
// clearly on its middle rather than on an atom.
function pickAll(cx, cy){
  const rect = canvas.getBoundingClientRect();
  let atom = -1, da = Infinity, bond = -1, db = Infinity;
  const scr = atoms.map(a => toScreen(a.p, rect));
  scr.forEach((s, i) => { if(s.z <= 1){ const d = Math.hypot(s.x - cx, s.y - cy); if(d < da){ da = d; atom = i; } } });
  bonds.forEach((b, k) => {
    const A = scr[b.a], B = scr[b.b]; if(!A || !B || A.z > 1 || B.z > 1) return;
    const dx = B.x - A.x, dy = B.y - A.y, L2 = dx*dx + dy*dy; if(L2 < 4) return;
    const t = ((cx - A.x)*dx + (cy - A.y)*dy) / L2; if(t < 0.2 || t > 0.8) return;
    const d = Math.hypot(A.x + t*dx - cx, A.y + t*dy - cy);
    if(d < db){ db = d; bond = k; }
  });
  if(da >= 32) atom = -1;
  if(db >= 16) bond = -1;
  if(bond >= 0 && atom >= 0 && db > da * 0.5) bond = -1;  // closer to the atom: treat as an atom tap
  if(bond >= 0) atom = -1;
  return {atom, bond};
}
function rayTo(cx, cy){
  const rect = canvas.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2((cx-rect.left)/rect.width*2-1, -((cy-rect.top)/rect.height)*2+1), camera);
  return raycaster.ray;
}
canvas.addEventListener('pointerdown', e => {
  unlockAudio();
  pointers.set(e.pointerId, {x:e.clientX, y:e.clientY});
  if(pointers.size > 1){ gesture = null; if(dragging !== null){ dragging = null; controls.enabled = true; rebuild(); } return; }
  const pk = busy ? {atom:-1, bond:-1} : pickAll(e.clientX, e.clientY);
  const hit = mode === 'move' && !busy ? pick(e.clientX, e.clientY) : pk.atom;
  gesture = {x:e.clientX, y:e.clientY, t:performance.now(), hit, bond: pk.bond, moved:false};
  if(hit >= 0) focusAtom = hit;
  if(mode === 'move' && hit >= 0 && !busy){
    dragging = hit; dragSnap = serialize(); controls.enabled = false;
    camera.getWorldDirection(tmpV);
    dragPlane.setFromNormalAndCoplanarPoint(tmpV.clone(), atoms[hit].p.clone().add(world.position));
    try{ canvas.setPointerCapture(e.pointerId); }catch{}
    SFX.tick(3); rebuild();
  }
}, {capture:true});
canvas.addEventListener('pointermove', e => {
  if(!pointers.has(e.pointerId)){
    if(e.pointerType === 'mouse' && !pointers.size && !busy){  // hover feedback on desktop
      const pk = pickAll(e.clientX, e.clientY);
      const hb = mode === 'move' ? -1 : pk.bond;
      canvas.style.cursor = (pk.atom >= 0 || hb >= 0) ? 'pointer' : '';
      if(hb !== hoverBond){ hoverBond = hb; rebuild(); }
    }
    return;
  }
  pointers.set(e.pointerId, {x:e.clientX, y:e.clientY});
  if(gesture && Math.hypot(e.clientX-gesture.x, e.clientY-gesture.y) > 10) gesture.moved = true;
  if(dragging !== null && pointers.size === 1){
    const pt = rayTo(e.clientX, e.clientY).intersectPlane(dragPlane, new THREE.Vector3());
    if(pt){ atoms[dragging].p.copy(pt.sub(world.position)); rebuild(); }
  }
});
function endPointer(e){
  pointers.delete(e.pointerId);
  if(dragging !== null){
    if(gesture && gesture.moved){ undoStack.push(dragSnap); changed(); }
    dragging = null; controls.enabled = true; gesture = null; rebuild(); return;
  }
  if(gesture && !gesture.moved && performance.now() - gesture.t < 500 && pointers.size === 0) onTap(gesture.hit, gesture.bond);
  gesture = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

function onTap(hit, bondHit = -1){
  if(busy) return;
  if(bondHit >= 0 && (mode === 'add' || (mode === 'bond' && bondFirst === null))){
    act(() => cycleOrder(bondHit)); return;
  }
  if(bondHit >= 0 && mode === 'delete'){ act(() => removeBond(bondHit)); return; }
  if(mode === 'add'){
    if(hit >= 0) act(() => growFrom(hit, element));
    else if(!atoms.length) act(() => { if(element === 'H') return fail('Start with a heavier atom!'); addAtom(element, new THREE.Vector3()); SFX.pop(element); buzz(10); burst(new THREE.Vector3(), EL[element].c, 24, 3, 0.6, 0.25); });
    else toast('Tap an atom to grow from it, tap a bond to change its order, or click an element button to add one');
  } else if(mode === 'bond'){
    if(hit < 0){ bondFirst = null; rebuild(); return; }
    if(bondFirst === null){ bondFirst = hit; SFX.tick(); rebuild(); }
    else if(hit === bondFirst){ bondFirst = null; rebuild(); }
    else { const a = bondFirst; bondFirst = null; act(() => cycleBond(a, hit)); rebuild(); }
  } else if(mode === 'delete'){
    if(hit >= 0) act(() => deleteAtom(hit));
  }
}

/* ================= submit & scoring ================= */
const sleep = ms => new Promise(r => setTimeout(r, ms));
function setCoords(x){ atoms.forEach((a,i) => a.p.set(x[3*i], x[3*i+1], x[3*i+2])); }
// info[i] = [stage, step, energy, max force] for frames[i] (from the server), shown as a readout.
async function animateFrames(frames, ms, info = null, unitOf = null){
  const step = Math.max(1, Math.floor(frames.length / 60)), sel = [];
  for(let i=0;i<frames.length;i+=step) sel.push(i);
  if(sel[sel.length-1] !== frames.length-1) sel.push(frames.length-1);
  const per = ms / sel.length, box = $('optInfo');
  const show = info && info.length === frames.length;
  if(show) box.classList.remove('hidden');
  for(const i of sel){
    setCoords(frames[i]); rebuild();
    if(show){
      const [stage, n, e, f] = info[i], u = unitOf ? unitOf(stage) : '';
      box.textContent = `${stage} · step ${n} · E ${e.toFixed(4)} ${u} · max force ${f.toFixed(3)}`;
    }
    await sleep(per);
  }
  if(show) setTimeout(() => box.classList.add('hidden'), 1200);
}

async function submit(){
  if(busy) return;
  if(puzzle) return submitPuzzle();
  if(!atoms.some(a => a.el !== 'H')) return fail('Build something first!');
  const vs = valenceState();
  if(vs.unbalanced.length){
    const i = vs.unbalanced[0];
    return fail(`${EL[atoms[i].el].name} with ${orderSum(i)} bonds needs a + charge, but no neighbor has a free bond to take the − (like in C≡O)`);
  }
  const snap = serialize();
  const free = freeHeavy();
  if(free > 0){
    const choice = await askFreeBonds(free);
    if(choice === 'cancel') return;
    if(choice === 'fill') fillH();
  }
  if(!connected()){ restore(snap); changed(); return fail('Your molecule is in pieces — connect everything'); }
  busy = true; document.body.classList.add('busy'); bondFirst = null;
  undoStack.push(snap);
  try{
    if(ONLINE){ await submitOnline(); return; }
    const built = serialize();
    const ff = buildFF();
    const x = new Float64Array(atoms.length*3);
    atoms.forEach((a,i) => x.set([a.p.x, a.p.y, a.p.z], 3*i));
    // tidy hydrogens only, so you're judged on the skeleton you built
    fire(ff, x, {mask: atoms.map(a => a.el === 'H'), maxSteps: 1500});
    const E0 = egrad(ff, x, new Float64Array(x.length));
    const frames = [Float64Array.from(x)];
    let res = fire(ff, x, {record: frames});
    // nudge test: if a small kick lowers the energy, we were stuck on a saddle point
    const y = Float64Array.from(x);
    for(let i=0;i<y.length;i++) y[i] += (Math.random()-0.5)*0.12;
    const r2 = fire(ff, y, {});
    let saddle = false;
    if(r2.E < res.E - 0.05){ saddle = true; x.set(y); res = r2; frames.push(Float64Array.from(x)); }
    const E1 = res.E, dEpa = Math.max(0, E0 - E1) / atoms.length;
    const stable = res.converged && sane(ff, x);

    toast('Optimizing…', 1300); SFX.whoosh();
    await animateFrames(frames, 1300);
    const broken = !sane(ff, x);
    let warning = null;
    if(broken){
      restore(built); rebuild(); changed();
      warning = 'The optimizer pulled the structure apart: bonds stretched or atoms collided. Your structure may be too far from a stable minimum. Try more reasonable bond lengths and angles (📏 Measure helps).';
    } else if(!res.converged){
      setCoords(x); changed();
      warning = "The optimization didn't converge, so the structure may still be far from a minimum.";
    } else {
      setCoords(x); changed();
      burst(centroid(), [0x7c5cff, 0x20d3a7, 0xffffff], 40, 4, 0.8, 0.28);
    }

    const smiles = getSmiles(), form = formula();
    const lines = [];
    const already = smiles && seen.has(smiles);
    let pubNew = null;
    if(stable && smiles && !already){ toast('Checking PubChem…', 3000); pubNew = await pubchemIsNew(smiles); }
    // Same order as the server's score card.
    if(already){
      lines.push(['Already collected', 0]);
    } else {
      if(stable && smiles){
        const rec = records[form];
        if(rec === undefined){ lines.push(['New QuMol formula', 1000]); records[form] = E1; }
        else if(E1 < rec - 0.01){ lines.push(['Formula record', 300, 'lowest energy yet for this formula']); records[form] = E1; }
        lines.push(['New QuMol SMILES', 100]);
      } else if(stable && !smiles) lines.push(['New QuMol SMILES', 0, 'chemistry engine offline']);
      lines.push(stable ? ['Stable', 50] : broken ? ['Optimization failed', 0, 'structure fell apart; no bonuses']
        : !res.converged ? ['Not converged', 0, 'no bonuses'] : ['Unstable', 0, 'no bonuses']);
      if(inputMethod === 'hand') lines.push(['Hand-built', 50]);
      if(inputMethod === 'example') lines.push(['Geometry', 0, 'example molecule']);
      else lines.push(['Geometry', Math.round(100*Math.exp(-dEpa/2)), `ΔE ${dEpa.toFixed(2)} kcal/mol per atom`]);
      if(saddle) lines.push(['Saddle point', 0, 'rolled off to a minimum']);
      const nRad = freeHeavy();
      if(nRad) lines.push(['Radical', 0, `${nRad} unpaired electron${nRad > 1 ? 's' : ''}`]);
      if(stable && valenceState().charge.some(q => q)) lines.push(['Formal charges', 50]);
      if(pubNew === true) lines.push(['Not in PubChem', 1000, 'possibly new to science']);
      if(stable){
        const n = atoms.length;
        lines.push(['Size bonus', Math.max(0, 1000 - 50*(Math.max(2, n) - 2)), `${n} atoms: smaller scores more`]);
      }
    }
    const score = already ? 0 : lines.reduce((s,l) => s + l[1], 0);

    if(!already){
      total += score;
      if(stable && smiles){ seen.add(smiles); LS.set('qm.seen', [...seen]); }
      history.unshift({smiles: smiles || form, formula: form, score, pubNew: pubNew === true});
      if(history.length > 200) history.length = 200;
      LS.set('qm.total', total); LS.set('qm.records', records); LS.set('qm.history', history);
    }
    await showScore({lines, score, discovery: pubNew === true && !already, formula: form, smiles,
                     pubchem: smiles ? {known: pubNew === null ? null : !pubNew} : null, warning});
    updateInfo();
  } finally {
    busy = false; document.body.classList.remove('busy');
  }
}

function askFreeBonds(free){
  return new Promise(resolve => {
    const card = openCard();
    const radicalOK = free <= MAX_RADICALS;
    card.innerHTML = `<h2>${free} free bond${free > 1 ? 's' : ''} left</h2>
      <p>Some atoms still have room for more bonds. Fill them with hydrogens, or keep them as
      <b>unpaired electrons</b> — a <b>radical</b>, like methyl •CH₃.</p>
      ${radicalOK ? '' : `<p style="opacity:.75">Radicals can have at most ${MAX_RADICALS} unpaired electrons, so this one needs hydrogens.</p>`}`;
    const done = v => { $('ov').classList.add('hidden'); SFX.tick(); resolve(v); };
    const fillB = document.createElement('button'); fillB.id = 'ovBtn'; fillB.textContent = 'Add hydrogens & build';
    fillB.onclick = () => done('fill'); card.appendChild(fillB);
    if(radicalOK){
      const radB = document.createElement('button'); radB.className = 'try';
      radB.textContent = `Build as a radical (${free} unpaired electron${free > 1 ? 's' : ''}) •`;
      radB.onclick = () => done('radical'); card.appendChild(radB);
    }
    const cancel = document.createElement('button'); cancel.className = 'link'; cancel.textContent = 'Keep editing';
    cancel.onclick = () => done('cancel'); card.appendChild(cancel);
  });
}

async function submitOnline(){
  if(!token){ showWelcome(); return; }
  const body = {
    atoms: atoms.map(a => ({el:a.el, x:a.p.x, y:a.p.y, z:a.p.z})),
    bonds: bonds.map(b => [b.a, b.b, b.o]),
    input_method: inputMethod, mode: 'stable',
  };
  SFX.whoosh();
  const before = serialize();
  const tStart = performance.now();
  const tick = () => toast(`Optimizing on the server… ${((performance.now() - tStart)/1000).toFixed(1)} s`, 60000);
  tick(); const timer = setInterval(tick, 200);
  let r;
  try{
  for(let attempt = 0; ; attempt++){
    try{ r = await api('/api/submissions', {method:'POST', body}); break; }
    catch(e){
      if(e.status === 401){ setAccount(null, null); showWelcome(); return; }
      if(e.status === 503 && attempt < 4){ toast('Server busy, retrying…', 3000); await sleep(1500 * (attempt + 1)); continue; }
      fail(e.message || 'Could not reach the server'); return;
    }
  }
  } finally { clearInterval(timer); }  // error toasts from fail() stay visible
  $('toast').classList.remove('show');
  const unitOf = stage => stage === 'toy force field' ? 'kcal/mol' : (r.method && r.method.energy_unit) || '';
  await animateFrames(r.frames.map(f => f.flat()), Math.min(4000, 1300 + 25 * r.frames.length), r.frame_info, unitOf);
  if(r.opt_status === 'broken'){
    restore(before); rebuild(); changed();  // give the player their structure back to fix
    shake = 0.25; buzz([20,40,20]);
  } else {
    setCoords(r.coords_opt.flat()); changed();
    burst(centroid(), [0x7c5cff, 0x20d3a7, 0xffffff], 40, 4, 0.8, 0.28);
  }
  total = r.total; LS.set('qm.total', total);
  await showScore({lines: r.lines, score: r.score, discovery: r.discovery, name: r.pubchem && r.pubchem.name,
                   formula: r.formula, smiles: r.smiles, pubchem: r.pubchem, warning: r.warning,
                   log: r.log, unitOf});
  updateInfo();
}

const PUBCHEM_LINK = /^https:\/\/pubchem\.ncbi\.nlm\.nih\.gov\/compound\/\d+$/;
function lineEl(label, pts, sub, cls='', link=null){
  const d = document.createElement('div'); d.className = 'line ' + cls;
  const l = document.createElement('div'); l.textContent = label;
  if(sub){
    const s = document.createElement('small');
    if(link && PUBCHEM_LINK.test(link)){  // only ever link to a PubChem compound page
      const a = document.createElement('a'); a.href = link; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = sub + ' ↗'; s.appendChild(a);
    } else s.textContent = sub;
    l.appendChild(s);
  }
  const p = document.createElement('div'); p.className = 'pts' + (pts === 0 ? ' zero' : ''); p.textContent = typeof pts === 'number' ? `+${pts}` : pts;
  d.append(l, p); return d;
}
function openCard(){ const card = $('card'); card.innerHTML = ''; card.className = 'card'; $('ov').classList.remove('hidden'); return card; }
function closeBtn(card, text='Keep building'){
  const b = document.createElement('button'); b.id = 'ovBtn'; b.textContent = text;
  b.onclick = () => { $('ov').classList.add('hidden'); SFX.tick(); };
  card.appendChild(b);
}
// Header: name, formula, SMILES and the PubChem link; then the score lines; then the total.
async function showScore({lines, score, discovery, name=null, formula:form=null, smiles=null, pubchem=null, warning=null, log=null, unitOf=null}){
  const card = openCard();
  const h = document.createElement('h2'); h.className = 'mname';
  h.textContent = name || (score > 0 || discovery ? 'New molecule' : 'Hmm…'); card.appendChild(h);
  if(form){
    const f = document.createElement('div'); f.className = 'mformula';
    for(const part of String(form).match(/[A-Z][a-z]?|\d+/g) || []){  // H2O → H<sub>2</sub>O, built without innerHTML
      if(/^\d+$/.test(part)){ const sb = document.createElement('sub'); sb.textContent = part; f.appendChild(sb); }
      else f.appendChild(document.createTextNode(part));
    }
    card.appendChild(f);
  }
  if(smiles){ const sm = document.createElement('div'); sm.className = 'msmiles'; sm.textContent = smiles; card.appendChild(sm); }
  const pc = document.createElement('div'); pc.className = 'mpubchem';
  if(pubchem && pubchem.known && pubchem.url && PUBCHEM_LINK.test(pubchem.url)){
    const a = document.createElement('a'); a.href = pubchem.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.textContent = `PubChem CID ${pubchem.cid} ↗`; pc.appendChild(a);
  } else if(pubchem && pubchem.known) pc.textContent = 'In PubChem';
  else if(pubchem && pubchem.known === false) pc.textContent = 'Not in PubChem';
  else if(smiles) pc.textContent = 'PubChem check unavailable';
  if(pc.textContent) card.appendChild(pc);
  if(discovery){ const w = document.createElement('div'); w.className = 'wow'; w.textContent = '🚀 Possibly new to science'; card.appendChild(w); }
  if(warning){ const w = document.createElement('div'); w.className = 'warnbox'; w.textContent = '⚠️ ' + warning; card.appendChild(w); }
  for(let i=0;i<lines.length;i++){ const [l,p,sub] = lines[i]; card.appendChild(lineEl(l, p, sub)); SFX.tick(i); await sleep(330); }
  const t = document.createElement('div'); t.id = 'ovTotal'; t.textContent = '0'; card.appendChild(t);
  const t0 = performance.now(), dur = Math.min(1400, 300 + score*2);
  await new Promise(res => {
    (function step(){
      const k = Math.min(1, (performance.now()-t0)/dur);
      t.textContent = `+${Math.round(score*(1-Math.pow(1-k,3)))}`;
      if(k < 1) requestAnimationFrame(step); else res();
    })();
  });
  if(discovery){
    SFX.fanfare(); shake = 0.6; buzz([60,40,60,40,120]);
    const c = centroid();
    for(let k=0;k<4;k++) setTimeout(() => burst(c, [0xffd166,0xff5ca8,0x7c5cff,0x20d3a7,0xffffff], 90, 7, 1.6, 0.35, 4), k*220);
  } else if(score > 0){ SFX.chime(); buzz(30); }
  else SFX.err();
  closeBtn(card);
  if(log) card.appendChild(logEl(log, unitOf));  // under the button, so it never pushes it off screen
}
// Collapsible optimization log: what ran, how long, what happened, and every step.
function logEl(log, unitOf){
  const d = document.createElement('details'); d.className = 'optlog';
  d.open = LS.get('qm.logOpen', false);
  d.addEventListener('toggle', () => LS.set('qm.logOpen', d.open));
  const sum = document.createElement('summary');
  sum.textContent = `Optimization log · ${log.method} · ${log.elapsed_s} s`;
  d.appendChild(sum);
  const ev = document.createElement('ul');
  for(const e of log.events || []){ const li = document.createElement('li'); li.textContent = e; if(e.startsWith('failed')) li.className = 'bad'; ev.appendChild(li); }
  d.appendChild(ev);
  if(log.steps && log.steps.length){
    const pre = document.createElement('pre');
    const rows = log.steps.map(([st, n, e, f]) => `${st.padEnd(16)} ${String(n).padStart(4)}  ${e.toFixed(5).padStart(14)} ${(unitOf ? unitOf(st) : '').padEnd(8)} ${f.toFixed(4).padStart(9)}`);
    pre.textContent = `${'stage'.padEnd(16)} ${'step'.padStart(4)}  ${'energy'.padStart(14)} ${''.padEnd(8)} ${'max force'.padStart(9)}\n` + rows.join('\n');
    d.appendChild(pre);
  }
  return d;
}
function showHelp(){
  const card = openCard();
  card.innerHTML = `<h2>How to play</h2>
  <p>Build a molecule atom by atom, then hit <b>Build</b> (the flask). It gets optimized and scored.</p>
  <p><b>➕ Add</b> — click an element button to drop an atom next to the molecule (it bonds automatically when close enough), or tap an atom to grow from it.</p>
  <p><b>Tap a bond</b> to change it: single → double → triple → single. On a computer, bonds light up when you hover.</p>
  <p><b>🔗 Bond</b> — tap two atoms to bond them. Tap the same pair again to cycle single → double → triple → none (great for rings).</p>
  <p><b>✋ Move</b> — drag atoms to perfect the geometry. The closer you are to the optimum, the more points.</p>
  <p><b>🧩 Puzzles</b> — you get a molecule's name, formula and SMILES; build it as close to its experimental 3D structure as you can, against the clock. Five daily puzzles from easy to hard, plus random ones. Leaderboards rank by puzzles solved, then total time. After you solve one, the experimental structure appears as a green outline over yours.</p>
  <p><b>📏 Measure</b> — shows bond lengths (Å) on the bonds and the angles (°) around the atom you tap or drag, live as you move it. Typical values: C–H 1.09, C–C 1.54, C=C 1.34, C=O 1.21 Å; 109.5° around a carbon with four bonds, 120° with a double bond.</p>
  <p><b>Charges & radicals</b> — O can make a 3rd bond (N a 4th): QuMol gives it a + charge and a neighbor the −, like ⁻C≡O⁺. If bonds are left free when you Build, you can fill them with H or keep a radical (up to 2 unpaired electrons).</p>
  <p><b>Delete</b> — tap an atom to remove it, or a bond to break it. <b>Undo</b> steps back one change, <b>Reset</b> starts over.</p>
  <p><b>H+</b> — saturates your molecule: every atom with free bonds gets hydrogens until it has its full valence (C 4, N 3, O 2, S 2). Build does this for you too.</p>
  <p><b>🏫 Learn</b> — how each element bonds, molecular shapes you can load in 3D, and a quiz. <b>XYZ</b> — shows the formula and coordinates as you build; edit the numbers to reshape the molecule directly.</p>
  <p style="opacity:.7">On a computer, hover over any button to see what it does. Loaded examples don't earn geometry or hand-built points; edited XYZ doesn't earn the hand-built bonus.</p>
  <p>One finger rotates, pinch zooms.</p>
  <p><b>Points:</b> geometry skill, stability, hand-built bonus, new molecules, formula records — and a huge bonus if it's <b>not in PubChem</b>. Smaller molecules score more.</p>
  <p style="opacity:.6;font-size:13px">Early prototype: energies come from a simple toy force field. A proper ML potential comes later.</p>`;
  closeBtn(card, "Let's build!");
}
async function showCollection(){
  if(ONLINE && !token) return showWelcome();
  let items = history.map(e => ({formula:e.formula, smiles:e.smiles, score:e.score, discovery:e.pubNew}));
  let email;
  if(ONLINE){
    try{
      const [me, mine] = await Promise.all([api('/api/me'), api('/api/submissions/mine')]);
      email = me.email;
      total = me.total; LS.set('qm.total', total); updateInfo();
      items = mine.map(s => ({formula:s.formula, smiles:s.smiles, score:s.score, discovery: s.stable && s.in_pubchem === 0}));
    }catch(e){ if(e.status === 401){ setAccount(null, null); return showWelcome(); } toast(e.message); }
  }
  const card = openCard();
  const h = document.createElement('h2'); h.textContent = `${nick ? nick + ' · ' : 'Your collection · '}${total.toLocaleString()} ⭐`; card.appendChild(h);
  if(!items.length){ const p = document.createElement('p'); p.textContent = 'Nothing yet. Go build something!'; card.appendChild(p); }
  items.slice(0, 50).forEach(e => card.appendChild(lineEl((e.discovery ? '🤯 ' : '') + e.formula, e.score, e.smiles)));
  if(ONLINE){
    const em = document.createElement('button'); em.className = 'link';
    em.textContent = email ? `Contact email: ${email} (change)` : 'Add a contact email (optional)';
    em.onclick = () => editEmail(email);
    card.appendChild(em);
  }
  closeBtn(card, 'Close');
}
function editEmail(current){
  const card = openCard();
  card.innerHTML = `<h2>Contact email</h2>
    <input id="emailEdit" type="email" maxlength="254" placeholder="Email (optional)" autocomplete="email">
    <small>Only used to contact you about QuMol. Never shown publicly. Leave empty to remove it.</small>
    <div class="err" id="emailErr"></div>`;
  $('emailEdit').value = current || '';
  const go = document.createElement('button'); go.id = 'ovBtn'; go.textContent = 'Save';
  const back = document.createElement('button'); back.className = 'link'; back.textContent = 'Back';
  card.append(go, back);
  go.onclick = async () => {
    try{ await api('/api/me', {method:'PATCH', body:{email: $('emailEdit').value.trim() || null}}); SFX.chime(); showCollection(); }
    catch(e){ $('emailErr').textContent = e.message; SFX.err(); }
  };
  back.onclick = () => showCollection();
}

function showWelcome(err=''){
  const card = openCard();
  card.innerHTML = `<h2>Welcome to QuMol</h2>
    <p>You played with building blocks as a kid. Now play with the universe's: <b>atoms</b>.</p>
    <p>Pick a nickname. It shows on the leaderboards, and it's how we credit you if your molecules end up in a published dataset.</p>
    <input id="nickIn" maxlength="24" placeholder="Nickname" autocomplete="nickname">
    <input id="emailIn" type="email" maxlength="254" placeholder="Email (optional)" autocomplete="email">
    <small>Optional. Only used to contact you about QuMol, for example if you discover something new. Never shown publicly.</small>
    <div class="err" id="nickErr"></div>`;
  const go = document.createElement('button'); go.id = 'ovBtn'; go.textContent = "Let's build!";
  const rec = document.createElement('button'); rec.className = 'link'; rec.textContent = 'I already have an account (recovery code)';
  card.append(go, rec);
  $('nickErr').textContent = err;
  go.onclick = async () => {
    unlockAudio();
    const n = $('nickIn').value.trim(); if(!n) return;
    go.disabled = true;
    try{
      const r = await api('/api/players', {method:'POST', body:{nickname:n, email:$('emailIn').value.trim() || null}});
      setAccount(r.token, r.nickname); total = 0; LS.set('qm.total', 0); updateInfo();
      SFX.chime(); showRecoveryCode(r.recovery_code);
    }catch(e){ $('nickErr').textContent = e.message; SFX.err(); go.disabled = false; }
  };
  rec.onclick = () => showRecover();
}
function showRecoveryCode(code){
  const card = openCard();
  card.innerHTML = `<h2></h2>
    <p>This is your <b>recovery code</b>. Save it (screenshot or password manager). It's the only way to get your account back on a new phone or browser.</p>
    <div class="code"></div>`;
  card.querySelector('h2').textContent = `You're in, ${nick}! 🎉`;
  card.querySelector('.code').textContent = code;
  closeBtn(card, "Saved, let's build!");
  if(!LS.get('qm.seenHelp', false)){ LS.set('qm.seenHelp', true); $('ovBtn').onclick = () => showHelp(); }
}
function showRecover(){
  const card = openCard();
  card.innerHTML = `<h2>Recover your account</h2>
    <input id="recNick" placeholder="Nickname" maxlength="24">
    <input id="recCode" placeholder="XXXX-XXXX-XXXX-XXXX" autocapitalize="characters">
    <div class="err" id="recErr"></div>`;
  const go = document.createElement('button'); go.id = 'ovBtn'; go.textContent = 'Recover';
  const back = document.createElement('button'); back.className = 'link'; back.textContent = 'Back';
  card.append(go, back);
  go.onclick = async () => {
    try{
      const r = await api('/api/players/recover', {method:'POST', body:{nickname:$('recNick').value, recovery_code:$('recCode').value}});
      setAccount(r.token, r.nickname); const me = await api('/api/me'); total = me.total; updateInfo();
      SFX.chime(); $('ov').classList.add('hidden'); toast(`Welcome back, ${r.nickname}!`);
    }catch(e){ $('recErr').textContent = e.message; SFX.err(); }
  };
  back.onclick = () => showWelcome();
}

let lbCats = null, lbCurrent = 'overall';
async function showLeaderboard(cat = lbCurrent){
  if(!ONLINE) return toast('Leaderboards need the QuMol server');
  lbCurrent = cat;
  try{
    if(!lbCats) lbCats = await api('/api/leaderboards');
    const data = await api('/api/leaderboard/' + cat);
    const card = openCard();
    const h = document.createElement('h2'); h.textContent = '🏆 ' + data.title; card.appendChild(h);
    const tabs = document.createElement('div'); tabs.className = 'tabs';
    for(const k of Object.keys(lbCats)){
      const b = document.createElement('button'); b.textContent = k; b.className = k === cat ? 'on' : '';
      b.onclick = () => { SFX.tick(); showLeaderboard(k); };
      tabs.appendChild(b);
    }
    card.appendChild(tabs);
    if(!data.rows.length){ const p = document.createElement('p'); p.textContent = 'Nobody here yet. Be the first!'; card.appendChild(p); }
    const medal = ['🥇','🥈','🥉'];
    data.rows.forEach(r => card.appendChild(lineEl(`${medal[r.rank-1] || r.rank + '.'} ${r.nickname}`, String(r.value), null, r.nickname === nick ? 'me' : '')));
    closeBtn(card, 'Close');
  }catch(e){ toast(e.message); }
}

/* ================= puzzle mode ================= */
// Build a named molecule by hand; the server scores it against the experimental structure.
// While a puzzle runs: no examples, no XYZ editing, no measuring; the player's own work is
// set aside and comes back on exit.
let puzzle = null, ghostShown = false, pzTimer = null;
const ghostGroup = new THREE.Group(); world.add(ghostGroup);
const ghostMat = new THREE.MeshBasicMaterial({color:0x20d3a7, transparent:true, opacity:0.28, depthWrite:false});
const ghostBondMat = new THREE.MeshBasicMaterial({color:0x20d3a7, transparent:true, opacity:0.35, depthWrite:false});

function formulaInto(el, form){  // H2O -> H<sub>2</sub>O without innerHTML
  el.textContent = '';
  for(const part of String(form).match(/[A-Z][a-z]?|\d+/g) || []){
    if(/^\d+$/.test(part)){ const sb = document.createElement('sub'); sb.textContent = part; el.appendChild(sb); }
    else el.appendChild(document.createTextNode(part));
  }
}
function fmtTime(sec){ const m = Math.floor(sec/60), x = Math.floor(sec%60); return `${m}:${String(x).padStart(2,'0')}`; }

async function showPuzzles(){
  if(!ONLINE) return toast('Puzzles need the QuMol server');
  if(!token) return showWelcome();
  let d;
  try{ d = await api('/api/puzzles/daily'); }catch(e){ return toast(e.message); }
  const card = openCard();
  card.innerHTML = `<h2>🧩 Puzzles</h2>
    <p>You get the name, formula and SMILES. Build it by hand, as close to its <b>experimental 3D structure</b> as you can; the clock starts when you open the puzzle. Leaderboards rank by puzzles solved, then by total time. Your first solve of each puzzle counts.</p>
    <h3 class="pzday"></h3><div class="pzlist"></div>`;
  card.querySelector('.pzday').textContent = `Today's puzzles · ${d.day}`;
  const list = card.querySelector('.pzlist');
  for(const p of d.puzzles){
    const done = p.solved_score !== null && p.solved_score !== undefined;
    const row = lineEl(`${p.slot}. ${p.name}`, done ? '✓ solved' : `${p.heavy} heavy`, null, done ? 'me' : '');
    const f = document.createElement('small'); formulaInto(f, p.formula);
    f.appendChild(document.createTextNode(`  ·  ${p.smiles}${p.note ? '  ·  ' + p.note : ''}`));
    row.firstChild.appendChild(f);
    row.onclick = () => startPuzzle({puzzle_id: p.id, daily: true});
    list.appendChild(row);
  }
  const rnd = document.createElement('button'); rnd.id = 'ovBtn'; rnd.textContent = `🎲 Random puzzle (${d.total_puzzles} molecules)`;
  rnd.onclick = () => startPuzzle({});
  const lb = document.createElement('button'); lb.className = 'link'; lb.textContent = '🏆 Puzzle leaderboards';
  lb.onclick = () => showLeaderboard('puzzle_daily');
  card.append(rnd, lb);
  closeBtn(card, 'Close');
}

async function startPuzzle(req){
  if(busy) return;
  let r;
  try{ r = await api('/api/puzzles/start', {method:'POST', body:req}); }catch(e){ return toast(e.message); }
  if(busy) return toast('Wait for the optimization to finish');  // Build was pressed while this loaded
  $('ov').classList.add('hidden');
  const entering = !puzzle;
  if(entering) puzzleSaved = serialize();  // the player's own work, restored on exit
  clearGhost();
  puzzle = {attempt: r.attempt_id, info: r.puzzle, daily: r.daily, practice: r.practice, t0: performance.now(), next: null};
  atoms = []; bonds = []; undoStack = []; inputMethod = 'hand'; bondFirst = null;
  if(entering) setPuzzleUI(true);  // a second call would save the puzzle's settings as the player's
  changed();
  formulaInto($('pzTitle'), ''); $('pzTitle').textContent = `🧩 ${r.puzzle.name} · `;
  const f = document.createElement('span'); formulaInto(f, r.puzzle.formula); $('pzTitle').appendChild(f);
  $('pzSub').textContent = [`SMILES ${r.puzzle.smiles}`, r.puzzle.note, r.practice ? 'practice: already solved, not counted' : null].filter(Boolean).join(' · ');
  clearInterval(pzTimer);
  pzTimer = setInterval(() => { if(puzzle) $('pzTimer').textContent = fmtTime((performance.now() - puzzle.t0)/1000); }, 500);
  $('pzTimer').textContent = '0:00';
  toast(`Clock started: build ${r.puzzle.name}, then Check`, 2600);
  SFX.chime();
}
let puzzleSaved = null, measureBefore = false, xyzBefore = false;
function setPuzzleUI(on){
  $('puzzleBar').classList.toggle('hidden', !on);
  document.body.classList.toggle('puzzling', on);
  $('submitLabel').textContent = on ? 'Check' : 'Build';
  if(on){ measureBefore = measureOn; measureOn = false; xyzBefore = xyzOpen; setXYZOpen(false, false); }
  else { measureOn = measureBefore; setXYZOpen(xyzBefore); }
  for(const id of ['measure', 'xyzBtn']){ $(id).classList.toggle('disabled', on); $(id).disabled = on; }
  $('measure').classList.toggle('on', measureOn);
}
function exitPuzzle(){
  if(!puzzle) return;
  if(busy) return toast('Checking your molecule…');
  puzzle = null; clearInterval(pzTimer); clearGhost(); setPuzzleUI(false);
  if(puzzleSaved){ restore(puzzleSaved); puzzleSaved = null; }
  undoStack = []; changed(); SFX.tick();
}
async function submitPuzzle(){
  if(!atoms.some(a => a.el !== 'H')) return fail('Build the molecule first!');
  if(!connected()) return fail('Your molecule is in pieces. Connect everything');
  busy = true; document.body.classList.add('busy');
  let r;
  try{
    r = await api('/api/puzzles/solve', {method:'POST', body:{
      attempt_id: puzzle.attempt,
      atoms: atoms.map(a => ({el:a.el, x:a.p.x, y:a.p.y, z:a.p.z})),
      bonds: bonds.map(b => [b.a, b.b, b.o])}});
  }catch(e){ busy = false; document.body.classList.remove('busy'); return fail(e.message || 'Could not reach the server'); }
  busy = false; document.body.classList.remove('busy');
  if(!puzzle) return;  // left the puzzle while it was being checked
  if(!r.correct){ shake = 0.3; buzz([20,40,20]); SFX.err(); return toast(`${r.message} ${r.tip || ''}`, 4500); }
  clearInterval(pzTimer);
  showGhost(r.ghost);
  const p = puzzle; p.solved = true;
  const card = openCard();
  const h = document.createElement('h2'); h.className = 'mname'; h.textContent = `🧩 ${r.puzzle.name}`; card.appendChild(h);
  const f = document.createElement('div'); f.className = 'mformula'; formulaInto(f, r.puzzle.formula); card.appendChild(f);
  const sm = document.createElement('div'); sm.className = 'msmiles'; sm.textContent = r.smiles; card.appendChild(sm);
  const st = document.createElement('div'); st.className = 'mpubchem';
  st.textContent = `Solved in ${fmtTime(r.seconds)}${r.tries > 1 ? ` · ${r.tries} tries` : ''}${r.practice ? ' · practice: solved before, not counted' : ''}`;
  card.appendChild(st);
  for(let i=0;i<r.lines.length;i++){ const [l,pts,sub] = r.lines[i]; card.appendChild(lineEl(l, pts < 0 ? String(pts) : pts, sub)); SFX.tick(i); await sleep(300); }
  if(r.diffs && r.diffs.length){
    const d = document.createElement('div'); d.className = 'diffs';
    const t = document.createElement('div'); t.innerHTML = '<b>Biggest differences</b><span>yours · experiment</span>'; d.appendChild(t);
    for(const x of r.diffs){
      const row = document.createElement('div');
      const a = document.createElement('span'); a.textContent = x.bond;
      const b = document.createElement('span'); b.textContent = `${x.yours.toFixed(3)} · ${x.experiment.toFixed(3)} Å`;
      row.append(a, b); d.appendChild(row);
    }
    card.appendChild(d);
  }
  const tot = document.createElement('div'); tot.id = 'ovTotal'; tot.textContent = `+${r.score}`; card.appendChild(tot);
  if(r.score > 0){ SFX.chime(); buzz(30); burst(centroid(), [0x7c5cff, 0x20d3a7, 0xffffff], 50, 4, 0.9, 0.3); }
  const src = document.createElement('div'); src.className = 'src';
  src.textContent = `Reference structure: ${(r.source && r.source.text) || ''}${r.source && r.source.doi ? ', doi:' + r.source.doi : ''}`;
  card.appendChild(src);
  const cmp = document.createElement('button'); cmp.id = 'ovBtn'; cmp.textContent = 'Compare in 3D';
  cmp.onclick = () => { $('ov').classList.add('hidden'); toast('Green outline: the experimental structure', 3000); };
  const next = document.createElement('button'); next.className = 'link'; next.textContent = '🧩 Next puzzle';
  next.onclick = () => showPuzzles();
  const out = document.createElement('button'); out.className = 'link'; out.textContent = 'Back to free building';
  out.onclick = () => { $('ov').classList.add('hidden'); exitPuzzle(); };
  card.append(cmp, next, out);
}
function showGhost(pos){
  clearGhost();
  if(!pos || pos.length !== atoms.length) return;
  pos.forEach((p, i) => {
    if(!p) return;
    const m = new THREE.Mesh(sphereGeo, ghostMat); m.scale.setScalar(EL[atoms[i].el].vis * 1.15);
    m.position.set(p[0], p[1], p[2]); ghostGroup.add(m);
  });
  bonds.forEach(b => {
    const A = pos[b.a], B = pos[b.b]; if(!A || !B) return;
    const p1 = new THREE.Vector3(...A), p2 = new THREE.Vector3(...B);
    const dir = p2.clone().sub(p1), L = dir.length(); if(L < 1e-6) return;
    const m = new THREE.Mesh(cylGeo, ghostBondMat);
    m.scale.set(0.05, L, 0.05); m.position.copy(p1).add(p2).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(Y, dir.normalize()); ghostGroup.add(m);
  });
  ghostShown = true;
}
function clearGhost(){ ghostGroup.clear(); ghostShown = false; }

/* ================= measure tool ================= */
// Bond lengths sit on the bonds; angles fan out around the focus atom (the last atom
// tapped or dragged, else the newest). Redrawn every frame, so they follow drags,
// rotation and the optimization movie.
const mlPool = [];
function mlLabel(k, text, x, y, cls){
  let el = mlPool[k];
  if(!el){ el = document.createElement('div'); $('measures').appendChild(el); mlPool[k] = el; }
  el.className = 'ml' + (cls ? ' ' + cls : ''); el.textContent = text;
  el.style.left = x + 'px'; el.style.top = y + 'px'; el.style.display = '';
}
function updateMeasures(){
  let k = 0;
  const placed = [];
  const free = (x, y) => placed.every(q => Math.abs(q[0] - x) > 46 || Math.abs(q[1] - y) > 17);
  if(measureOn && atoms.length > 1){
    const rect = canvas.getBoundingClientRect();
    const deg = i => bonds.reduce((n, b) => n + (b.a === i || b.b === i), 0);
    let f = dragging !== null ? dragging : (focusAtom !== null && focusAtom < atoms.length ? focusAtom : -1);
    if(f < 0) for(let i = atoms.length - 1; i >= 0; i--) if(deg(i) >= 2){ f = i; break; }  // newest atom with an angle
    if(f < 0) f = atoms.length - 1;
    const many = bonds.length > 24;  // big molecules: only the focus atom's bonds, to keep it readable
    bonds.forEach(b => {
      if(many && b.a !== f && b.b !== f) return;
      const A = atoms[b.a].p, B = atoms[b.b].p;
      const s = toScreen(A.clone().add(B).multiplyScalar(0.5), rect);
      if(s.z < 1){ mlLabel(k++, A.distanceTo(B).toFixed(2), s.x, s.y); placed.push([s.x, s.y]); }
    });
    const nb = [];
    bonds.forEach(b => { if(b.a === f) nb.push(b.b); else if(b.b === f) nb.push(b.a); });
    const c = atoms[f].p;
    for(let i = 0; i < nb.length; i++) for(let j = i + 1; j < nb.length && k < 60; j++){
      const u = atoms[nb[i]].p.clone().sub(c), v = atoms[nb[j]].p.clone().sub(c);
      if(u.lengthSq() < 1e-8 || v.lengthSq() < 1e-8) continue;
      const ang = THREE.MathUtils.radToDeg(u.angleTo(v));
      const dir = u.normalize().add(v.normalize());
      if(dir.lengthSq() < 1e-4) dir.copy(perpOf(u));  // linear: put the label beside the atom
      dir.normalize();
      let s = null;
      for(const r of [0.62, 0.9, 1.2, 1.5, 1.8]){  // step outward until the label doesn't cover another
        s = toScreen(c.clone().addScaledVector(dir, r), rect);
        if(free(s.x, s.y)) break;
      }
      if(s.z < 1){ mlLabel(k++, ang.toFixed(1) + '°', s.x, s.y, 'ang'); placed.push([s.x, s.y]); }
    }
  }
  for(let i = k; i < mlPool.length; i++) mlPool[i].style.display = 'none';
}

/* ================= main loop ================= */
let last = performance.now();
function loop(now){
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - last)/1000); last = now;
  updateBursts(dt);
  if(atoms.some(a => a.born && now - a.born < 360)) rebuild();
  if(shake > 0.001){ world.position.set((Math.random()-0.5)*shake, (Math.random()-0.5)*shake, 0); shake *= 0.9; }
  else world.position.set(0,0,0);
  if(atoms.length && dragging === null) controls.target.lerp(centroid(), 0.06);
  scene.getObjectByName('stars').rotation.y += dt*0.01;
  controls.update();
  renderer.render(scene, camera);
  updateMeasures();
}

/* ================= start ================= */
{
  let w = null; try{ w = localStorage.getItem('qm.work'); }catch{}
  if(w) restore(w);
  rebuild(); updateInfo(); setXYZOpen(xyzOpen);
  requestAnimationFrame(loop);
  detectServer().then(async () => {
    $('lb').classList.toggle('hidden', !ONLINE);
    $('puzzleBtn').classList.toggle('hidden', !ONLINE);
    if(!ONLINE) loadRDKit(); else updateInfo();
    if(ONLINE && !token) return showWelcome();
    if(ONLINE){
      try{ const me = await api('/api/me'); total = me.total; nick = me.nickname; LS.set('qm.total', total); updateInfo(); }
      catch(e){ if(e.status === 401){ setAccount(null, null); return showWelcome(); } }
    } else toast('Offline mode: scores stay on this device', 2500);
    if(!LS.get('qm.seenHelp', false)){ LS.set('qm.seenHelp', true); showHelp(); }
  });
}
