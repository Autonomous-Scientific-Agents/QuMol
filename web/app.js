import * as THREE from './vendor/three.module.js';
import {OrbitControls} from './vendor/OrbitControls.js';
import {openLesson} from './lesson.js';

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
// The cooking icon: a witch's cauldron with a bubbling green brew over a fire.
const POT_SVG = `<svg class="pot" viewBox="0 0 32 32" aria-hidden="true">
<path d="M9.5 31c-1.6-1.4-1.4-3.4.2-4.8.1 1.3.9 1.9 1.6 2-.4-1.6.4-3 1.9-3.9-.3 1.6.6 2.6 1.4 2.9.1-1.5 1-2.8 2.4-3.4-.5 1.7.3 2.9 1.2 3.4.4-1.1 1.2-1.8 2.2-2 .1 1.3-.3 2.2.6 3.1.6-.6 1-1.4 1-2.3 1.3 1.4 1.6 3.4.2 5z" fill="#ff7a1a"/>
<path d="M12.5 31c-.8-.9-.6-2 .3-2.8.2.8.7 1.1 1.2 1.2 0-1 .6-1.9 1.6-2.4-.1 1 .5 1.6 1.1 1.8.3-.6.8-1 1.4-1.1-.1.9.6 1.4.9 2.1.3-.3.5-.7.5-1.1.8.8.8 1.7.2 2.3z" fill="#ffd166"/>
<path d="M8 26.5l-1.6 3M24 26.5l1.6 3" stroke="#1a1d24" stroke-width="1.8" stroke-linecap="round"/>
<path d="M4.6 13.5h22.8c1.1 3 1.2 6.1-.2 8.6-1.9 3.4-6 5.4-11.2 5.4S6.7 25.5 4.8 22.1c-1.4-2.5-1.3-5.6-.2-8.6z" fill="#2a2e38" stroke="#14161c" stroke-width=".8"/>
<path d="M7 16c-.6 2.2-.3 4.4 1 6" stroke="#5a6273" stroke-width="1.3" stroke-linecap="round" fill="none"/>
<rect x="2.6" y="11.2" width="26.8" height="3.6" rx="1.8" fill="#4a5163" stroke="#14161c" stroke-width=".8"/>
<ellipse cx="16" cy="11.7" rx="11.6" ry="1.9" fill="#3dff8f"/>
<path d="M8 11.6c1.8-.9 3.3.6 5 0s3.3-.9 5 0 3.3.5 5.5-.2" stroke="#b6ffd2" stroke-width=".9" fill="none" stroke-linecap="round"/>
<circle cx="12.4" cy="7.6" r="2.1" fill="#5dffa3" stroke="#b6ffd2" stroke-width=".6"/>
<circle cx="18.6" cy="5" r="1.5" fill="#5dffa3" stroke="#b6ffd2" stroke-width=".5"/>
<circle cx="21.6" cy="8.6" r="1.1" fill="#5dffa3" stroke="#b6ffd2" stroke-width=".5"/>
<circle cx="15.5" cy="2.2" r=".8" fill="#9dffd0"/>
<circle cx="11.8" cy="7" r=".6" fill="#eafff3"/>
</svg>`;
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
let ONLINE = false, SERVER = {};  // SERVER: the /api/health answer (method, whether cooking is set up)
let token = LS.get('qm.token', null), nick = LS.get('qm.nick', null);
async function api(path, {method='GET', body} = {}){
  const headers = {};
  if(body) headers['Content-Type'] = 'application/json';
  if(token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(path, {method, headers, body: body ? JSON.stringify(body) : undefined});
  let j = null; try{ j = await r.json(); }catch{}
  if(!r.ok) throw apiError(r, j);
  return j;
}
function apiError(r, j){
  let msg = j && j.detail;
  if(Array.isArray(msg)) msg = msg.map(d => d.msg).join('; ');
  const e = new Error(msg || `Server error ${r.status}`); e.status = r.status; return e;
}
// POST that streams newline-delimited JSON events; onEvent gets each one until the result.
async function apiStream(path, body, onEvent){
  const headers = {'Content-Type': 'application/json'};
  if(token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(path, {method: 'POST', headers, body: JSON.stringify(body)});
  if(!r.ok){ let j = null; try{ j = await r.json(); }catch{} throw apiError(r, j); }
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = '';
  for(;;){
    const {value, done} = await reader.read();
    if(done) break;
    buf += dec.decode(value, {stream: true});
    let k;
    while((k = buf.indexOf('\n')) >= 0){
      const line = buf.slice(0, k); buf = buf.slice(k + 1);
      if(!line.trim()) continue;
      const ev = JSON.parse(line);
      if(ev.type === 'result') return ev.result;
      if(ev.type === 'error'){ const e = new Error(ev.detail || `Server error ${ev.status}`); e.status = ev.status; throw e; }
      onEvent(ev);
    }
  }
  throw new Error('The connection closed before the result arrived. Try Build again.');
}
async function detectServer(){
  try{
    const ctl = new AbortController(); setTimeout(() => ctl.abort(), 8000);
    const r = await fetch('/api/health', {signal: ctl.signal});
    SERVER = r.ok ? await r.json() : {};
    ONLINE = !!SERVER.ok;
  }catch{ ONLINE = false; }
  $('ver').textContent = versionText();
}
// "QuMol v0.3.0 · f51439a": the server's version and the commit it runs.
function versionText(){
  if(!ONLINE || !SERVER.version) return 'QuMol · offline mode';
  return `QuMol v${SERVER.version}${SERVER.commit ? ' · ' + SERVER.commit : ''}`;
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
const renderer = new THREE.WebGLRenderer({canvas, antialias:true, alpha:true});
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
const MINUS_RANK = {O:0, N:1, S:2, C:3, F:4};
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
      const next = [], cands = [];
      for(const u of frontier){
        for(const v of nb[u]){
          if(seen.has(v)) continue; seen.add(v);
          if(atoms[v].el !== 'H' && deficit[v] > 0 && charge[v] === 0) cands.push(v);
          next.push(v);
        }
      }
      if(cands.length){
        cands.sort((a, b) => (MINUS_RANK[atoms[a].el] ?? 9) - (MINUS_RANK[atoms[b].el] ?? 9) || a - b);
        partner = cands[0];
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
const METHOD_RANK = {hand:0, xyz:1, cook:2, example:3};
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

// Distinct bond types ("C–H", "C=C", "O–H"), ordered like the server's scoring.bond_types:
// carbon first, hydrogen last, the rest alphabetically, then by bond order.
function bondTypes(){
  const rank = el => (el === 'C' ? '0' : el === 'H' ? '2' : '1') + el;
  const seen = new Map();
  for(const b of bonds){
    const [x, y] = [atoms[b.a].el, atoms[b.b].el].sort((p, q) => rank(p) < rank(q) ? -1 : rank(p) > rank(q) ? 1 : 0);
    seen.set(`${x}|${y}|${b.o}`, {x, y, o: b.o});
  }
  const cmp = (p, q) => p < q ? -1 : p > q ? 1 : 0;
  return [...seen.values()].sort((p, q) => cmp(rank(p.x), rank(q.x)) || cmp(rank(p.y), rank(q.y)) || p.o - q.o)
    .map(t => t.x + ['', '–', '=', '≡'][t.o] + t.y);
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
// Phone menu: the ☰ button opens the top-bar buttons as a vertical list; any choice closes it.
function setMenu(open){ $('top').classList.toggle('menu-open', open); $('menuBtn').setAttribute('aria-expanded', open); }
$('menuBtn').onclick = e => { e.stopPropagation(); unlockAudio(); SFX.tick(); setMenu(!$('top').classList.contains('menu-open')); };
$('more').addEventListener('click', e => { if(e.target.closest('button') && e.target.closest('button').id !== 'mute') setMenu(false); });
document.addEventListener('pointerdown', e => { if(!e.target.closest('#more, #menuBtn')) setMenu(false); });
document.addEventListener('keydown', e => { if(e.key === 'Escape') setMenu(false); });
$('mute').onclick = () => { unlockAudio(); muted = !muted; LS.set('qm.muted', muted); $('mute').textContent = muted ? '🔇' : '🔊'; };
$('help').onclick = () => { unlockAudio(); showHelp(); };
$('total').onclick = () => { unlockAudio(); showCollection(); };
$('lb').onclick = () => { unlockAudio(); showLeaderboard(); };
$('puzzleBtn').onclick = () => { unlockAudio(); SFX.tick(); showPuzzles(); };
$('cookBtn').innerHTML = POT_SVG;
$('cookBtn').onclick = () => { unlockAudio(); SFX.tick(); showCook(); };
$('pzExit').onclick = () => { unlockAudio(); exitPuzzle(); };

/* ================= formula / XYZ panel ================= */
let xyzOpen = LS.get('qm.xyzOpen', innerWidth > 640);
let xyzTimer = 0;
function setXYZOpen(open, remember = true){
  xyzOpen = open; if(remember) LS.set('qm.xyzOpen', open);
  $('xyzPanel').classList.toggle('hidden', !open);
  $('xyzBtn').classList.toggle('on', open);
  if(open && innerWidth <= 640 && plotOpen) setPlotOpen(false);  // one panel at a time on a phone
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

/* ================= optimization plots panel ================= */
// Energy and max force at every optimization step of the last build: filled live from the
// streamed frames, then replaced by the full list of steps when the result arrives.
const plot = {method: null, points: [], reused: false, running: false, elapsed: null};
let plotOpen = false;
function setPlotOpen(open){
  plotOpen = open;
  $('plotPanel').classList.toggle('hidden', !open);
  $('plotBtn').classList.toggle('on', open);
  if(open && innerWidth <= 640 && xyzOpen) setXYZOpen(false);  // one panel at a time on a phone
  if(open) drawPlots();
}
$('plotBtn').onclick = () => { unlockAudio(); setPlotOpen(!plotOpen); SFX.tick(); };
$('plotClose').onclick = () => { setPlotOpen(false); SFX.tick(); };
// The toy force field (also the pre-relaxation before an ML potential) works in kcal/mol.
const plotUnit = stage => stage === 'toy force field' ? 'kcal/mol' : (plot.method && plot.method.energy_unit) || '';
function plotStart(method, reused){
  Object.assign(plot, {method, points: [], reused, running: true, elapsed: null});
  drawPlots();
}
function plotAdd(points){ plot.points.push(...points); if(plotOpen) drawPlots(); }
function plotDone(r){
  Object.assign(plot, {method: r.method, points: (r.log && r.log.steps) || plot.points, reused: !!r.reused,
                       running: false, elapsed: r.log ? r.log.elapsed_s : null});
  drawPlots();
}
const fmtNum = v => Math.abs(v) >= 1000 || (Math.abs(v) < 0.01 && v !== 0) ? v.toExponential(1) : +v.toPrecision(3) + '';
// A line chart as inline SVG. pts: [[x, y]]; marks: [[x, label]] (stage boundaries).
function chartSVG(pts, cls, {log = false, marks = []} = {}){
  const W = 320, H = 130, L = 46, R = 8, T = 8, B = 20;
  const ys = pts.map(p => log ? Math.log10(Math.max(p[1], 1e-6)) : p[1]);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if(hi - lo < 1e-9){ lo -= 1; hi += 1; }
  const x0 = pts[0][0], x1 = Math.max(pts[pts.length-1][0], x0 + 1);
  const X = x => L + (x - x0) / (x1 - x0) * (W - L - R), Y = y => T + (hi - y) / (hi - lo) * (H - T - B);
  let g = '';
  for(const t of [lo, (lo + hi) / 2, hi]){
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${Y(t)}" y2="${Y(t)}"/>`;
    g += `<text x="${L - 4}" y="${Y(t) + 3}" text-anchor="end">${fmtNum(log ? 10 ** t : t)}</text>`;
  }
  for(const [x, label] of marks)
    g += `<line class="stage" x1="${X(x)}" x2="${X(x)}" y1="${T}" y2="${H - B}"/><text x="${X(x) + 3}" y="${T + 9}">${label}</text>`;
  g += `<text x="${L}" y="${H - 5}">${x0}</text><text x="${W - R}" y="${H - 5}" text-anchor="end">step ${x1}</text>`;
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p[0]).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join('');
  const last = pts[pts.length-1];
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img">${g}<path class="ln ${cls}" d="${d}"/>` +
         `<circle class="${cls} dot" cx="${X(last[0])}" cy="${Y(ys[ys.length-1])}" r="3"/></svg>`;
}
function drawPlots(){
  if(!plotOpen) return;
  const meta = $('plotMeta'), charts = $('plotCharts');
  if(!ONLINE){ meta.textContent = 'Plots need the QuMol server: offline builds use a quick local force field.'; charts.innerHTML = ''; return; }
  if(!plot.method){ charts.innerHTML = ''; return; }
  // One energy scale per chart: plot the steps in the method's own units. A pre-relaxation with
  // the toy force field (different units) is summarized in words instead.
  const unit = plot.method.energy_unit;
  const main = plot.points.filter(p => plotUnit(p[0]) === unit);
  const pre = plot.points.filter(p => plotUnit(p[0]) !== unit);
  const preSteps = pre.length ? Math.max(...pre.map(p => p[1])) : 0;
  const status = plot.running ? (plot.reused ? 'replaying an earlier calculation…' : 'optimizing…')
    : plot.reused ? 'reused from an earlier calculation of the same start'
    : plot.elapsed !== null ? `took ${plot.elapsed} s` : '';
  meta.textContent = [`${plot.method.name} ${plot.method.version}`, status,
    preSteps ? `after ${preSteps} toy force field steps (not plotted: kcal/mol)` : ''].filter(Boolean).join(' · ');
  if(main.length < 2){ charts.innerHTML = `<div class="ctitle">${plot.running ? 'Waiting for the first steps…' : 'Not enough steps to plot.'}</div>`; return; }
  // x: running step count across stages; a dashed line where a new stage starts.
  const xs = [], marks = [];
  let off = 0, prev = null, last = 0;
  for(const [stage, n] of main){
    if(prev !== null && stage !== prev){ off = last + 1; if(prev !== 'input') marks.push([off, stage]); }
    last = off + n; xs.push(last); prev = stage;
  }
  const eEnd = main[main.length-1][2];
  charts.innerHTML =
    `<div class="ctitle">Energy relative to the last step (${unit})</div>` +
    chartSVG(main.map((p, i) => [xs[i], p[2] - eEnd]), 'e', {marks}) +
    `<div class="ctitle">Max force (${unit}/Å, log scale)</div>` +
    chartSVG(main.map((p, i) => [xs[i], p[3]]), 'f', {log: true, marks});
}
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
const quizState = {streak:0, best:Math.max(0, Math.floor(Number(LS.get('qm.quizBest', 0))) || 0), order:[], i:0, right:0, answered:-1};
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
  lessonBtn(card, '🌱 New here? Start with the beginner lesson').style.margin = '0 0 10px';
  const tabs = document.createElement('div'); tabs.className = 'tabs';
  for(const [k, label] of [['elements','⚛️ Elements'], ['shapes','📐 Bonds & shapes'], ['quiz','❓ Quiz']]){
    const b = document.createElement('button'); b.textContent = label; b.className = k === tab ? 'on' : '';
    b.onclick = () => { SFX.tick(); showLearn(k); }; tabs.appendChild(b);
  }
  card.appendChild(tabs);
  const body = document.createElement('div'); card.appendChild(body);
  ({elements: learnElements, shapes: learnShapes, quiz: learnQuiz})[tab](body);
  closeBtn(card, 'Back to building');
  const back = document.createElement('button'); back.className = 'link'; back.textContent = '← How to play';
  back.onclick = () => { SFX.tick(); showHelp(); };
  card.appendChild(back);
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
  if(!s.order.length){ s.order = QUIZ.map((_,i) => i).sort(() => Math.random() - 0.5); s.i = 0; s.right = 0; }
  if(s.i >= s.order.length){  // every question answered
    const all = s.right === QUIZ.length;
    body.innerHTML = `<div class="quizq" style="text-align:center">${all ? '🏆 Perfect!' : '🎉'} All questions answered</div>
      <p style="text-align:center">You got <b>${s.right} of ${QUIZ.length}</b> right. Best streak: ${s.best}.</p>`;
    const again = document.createElement('button'); again.textContent = 'Start the quiz again'; again.style.width = '100%';
    again.onclick = () => { s.order = []; s.streak = 0; s.answered = -1; SFX.tick(); showLearn('quiz'); };
    body.appendChild(again);
    if(all){ SFX.chime(); buzz(30); badgeEvent('quiz'); }
    return;
  }
  const q = QUIZ[s.order[s.i]];
  body.innerHTML = `<div class="streak">🔥 Streak ${s.streak} · Best ${s.best} · Question ${s.i+1}/${QUIZ.length}</div><div class="quizq">${q.q}</div>`;
  const opts = document.createElement('div'); opts.className = 'quizopts'; body.appendChild(opts);
  q.a.forEach((txt, k) => {
    const b = document.createElement('button'); b.textContent = txt; opts.appendChild(b);
    b.onclick = () => {
      opts.querySelectorAll('button').forEach((x, j) => { x.disabled = true; if(j === q.c) x.classList.add('right'); });
      const ok = k === q.c, first = s.answered !== s.i;  // switching tabs re-shows the question
      s.answered = s.i;
      if(first){ if(ok){ s.right++; s.streak++; if(s.streak > s.best){ s.best = s.streak; LS.set('qm.quizBest', s.best); } } else s.streak = 0; }
      if(ok){ SFX.chime(); buzz(30); }
      else { b.classList.add('wrong'); SFX.err(); buzz([20,40,20]); }
      const e = document.createElement('div'); e.className = 'qexp';
      e.innerHTML = `<b>${ok ? (s.streak >= 3 ? `🔥 ${s.streak} in a row!` : '✅ Correct!') : '❌ Not quite.'}</b> ${q.e}`;
      const next = document.createElement('button'); next.textContent = s.i + 1 < QUIZ.length ? 'Next question →' : 'See results →'; next.style.marginTop = '10px'; next.style.width = '100%';
      next.onclick = () => { s.i++; SFX.tick(); showLearn('quiz'); };
      body.append(e, next);
      body.querySelector('.streak').textContent = `🔥 Streak ${s.streak} · Best ${s.best} · Question ${s.i+1}/${QUIZ.length}`;
    };
  });
}

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
  if(pointers.size > 1){ gesture = null; if(dragging !== null){ dragging = null; controls.enabled = !cooking || canOrbitPot(); rebuild(); } return; }
  const pk = busy && !canEditPot() ? {atom:-1, bond:-1} : pickAll(e.clientX, e.clientY);
  const hit = mode === 'move' && !busy ? pick(e.clientX, e.clientY) : pk.atom;
  gesture = {x:e.clientX, y:e.clientY, t:performance.now(), hit, bond: pk.bond, moved:false};
  if(hit >= 0) focusAtom = hit;
  if(canEditPot() && hit >= 0){  // in the kitchen any atom can be dragged around the pot
    const a = atoms[hit]; if(a.drop){ a.p.copy(a.drop.to); delete a.drop; }
    dragging = hit;
    camera.getWorldDirection(tmpV);
    dragPlane.setFromNormalAndCoplanarPoint(tmpV.clone(), a.p.clone().add(world.position));
    try{ canvas.setPointerCapture(e.pointerId); }catch{}
    CSFX.grab(); rebuild(); return;
  }
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
    if(pt){ atoms[dragging].p.copy(pt.sub(world.position)); if(cooking) settleInPot(dragging); rebuild(); }
  }
});
function endPointer(e){
  pointers.delete(e.pointerId);
  if(dragging !== null && cooking){  // kitchen: a tap scoops the atom out, a drag puts it down
    const i = dragging, moved = gesture && gesture.moved; dragging = null; gesture = null;
    if(moved){ settleInPot(i); CSFX.place(atoms[i].el); rebuild(); } else removeIngredient(i);
    return;
  }
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
  if(cooking){ if(hit >= 0) removeIngredient(hit); return; }  // in the kitchen a tap scoops an atom out
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
    // Same order and rules as the server's score card: points need a stable molecule with a
    // SMILES, since "Already collected" is keyed on it (anything else could be farmed).
    const scorable = stable && !!smiles;
    if(already){
      lines.push(['Already collected', 0]);
    } else {
      if(stable && smiles){
        const rec = records[form];
        if(rec === undefined){ lines.push(['New QuMol formula', 1000]); records[form] = E1; }
        else if(E1 < rec - 0.01){ lines.push(['Formula record', 300, 'lowest energy yet for this formula']); records[form] = E1; }
        lines.push(['New QuMol SMILES', 100]);
      } else if(stable && !smiles) lines.push(['New QuMol SMILES', 0, 'chemistry engine offline']);
      lines.push(scorable ? ['Stable', 50] : stable ? ['Stable', 0, 'no points without a readable SMILES']
        : broken ? ['Optimization failed', 0, 'structure fell apart; no bonuses']
        : !res.converged ? ['Not converged', 0, 'no bonuses'] : ['Unstable', 0, 'no bonuses']);
      if(inputMethod === 'hand') lines.push(['Hand-built', scorable ? 50 : 0]);
      if(inputMethod === 'example') lines.push(['Geometry', 0, 'example molecule']);
      else lines.push(['Geometry', scorable ? Math.round(100*Math.exp(-dEpa/2)) : 0, `ΔE ${dEpa.toFixed(2)} kcal/mol per atom`]);
      if(saddle) lines.push(['Saddle point', 0, 'rolled off to a minimum']);
      const nRad = freeHeavy();
      if(nRad) lines.push(['Radical', 0, `${nRad} unpaired electron${nRad > 1 ? 's' : ''}`]);
      if(scorable && valenceState().charge.some(q => q)) lines.push(['Formal charges', 50]);
      if(pubNew === true) lines.push(['Not in PubChem', Math.round(1000*10**(3/atoms.length)), `possibly new to science · 1000 × 10^(3/${atoms.length} atoms)`]);
      if(scorable){ const t = bondTypes(); lines.push(['Bond types', 20*t.length, t.join(', ')]); }
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
  let reused = false, live = 0, method = null;
  const tick = () => toast(`${reused ? 'Same start as an earlier build: replaying it' : 'Optimizing on the server'}… ${((performance.now() - tStart)/1000).toFixed(1)} s`, 60000);
  tick(); const timer = setInterval(tick, 200);
  const unitOf = stage => stage === 'toy force field' ? 'kcal/mol' : (method && method.energy_unit) || '';
  const box = $('optInfo');
  // Live: atoms move as the server optimizes, and the plots fill in.
  const onEvent = ev => {
    if(ev.type === 'start'){ method = ev.method; reused = ev.reused; live = 0; plotStart(ev.method, ev.reused); }
    else if(ev.type === 'frame'){
      if(ev.coords.length !== atoms.length) return;
      live++; setCoords(ev.coords.flat()); rebuild(); plotAdd(ev.points);
      const p = ev.points[ev.points.length - 1];
      if(p){ box.classList.remove('hidden'); box.textContent = `${p[0]} · step ${p[1]} · E ${p[2].toFixed(4)} ${unitOf(p[0])} · max force ${p[3].toFixed(3)}`; }
    }
  };
  let r;
  try{
  for(let attempt = 0; ; attempt++){
    try{ r = await apiStream('/api/submissions/stream', body, onEvent); break; }
    catch(e){
      if(e.status === 401){ setAccount(null, null); showWelcome(); return; }
      if(live) restore(before), rebuild();  // put the player's start back before retrying or bailing
      if(e.status === 503 && attempt < 4){ toast('Server busy, retrying…', 3000); await sleep(1500 * (attempt + 1)); continue; }
      fail(e.message || 'Could not reach the server'); return;
    }
  }
  } finally { clearInterval(timer); setTimeout(() => box.classList.add('hidden'), 1200); }  // error toasts from fail() stay visible
  $('toast').classList.remove('show');
  method = r.method;
  plotDone(r);
  // Quick optimizations finish before many frames stream: play the movie from the result.
  if(live < 10) await animateFrames(r.frames.map(f => f.flat()), Math.min(4000, 1300 + 25 * r.frames.length), r.frame_info, unitOf);
  if(r.opt_status === 'broken'){
    restore(before); rebuild(); changed();  // give the player their structure back to fix
    shake = 0.25; buzz([20,40,20]);
  } else {
    setCoords(r.coords_opt.flat()); changed();
    burst(centroid(), [0x7c5cff, 0x20d3a7, 0xffffff], 40, 4, 0.8, 0.28);
  }
  total = r.total; LS.set('qm.total', total); checkBadges();
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
  const p = document.createElement('div'); p.className = 'pts' + (pts === 0 ? ' zero' : ''); p.textContent = typeof pts === 'number' ? `+${pts.toLocaleString()}` : pts;
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
      t.textContent = `+${Math.round(score*(1-Math.pow(1-k,3))).toLocaleString()}`;
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
// The beginner lesson (lesson.js): atoms, electrons, valence, bonds and lone pairs.
function startLesson(){
  unlockAudio(); $('ov').classList.add('hidden');
  openLesson({sfx:SFX, ls:LS, onBuild:key => loadExample(key), onQuiz:() => showLearn('quiz'), onFinish:() => badgeEvent('lesson')});
}
function lessonBtn(card, text = '🌱 New to chemistry? Start the beginner lesson'){
  const b = document.createElement('button'); b.className = 'try lessonBtn'; b.textContent = text;
  b.onclick = () => { SFX.tick(); startLesson(); };
  card.appendChild(b); return b;
}
// First run: the essentials only. The ? button has the full guide and the tutorial.
function showIntro(){
  const card = openCard();
  card.innerHTML = `<h2>How to play</h2>
  <p>Pick an element at the bottom and tap to add atoms. Tap a bond to make it double or triple.</p>
  <p>Hit <b>Build</b> (the flask): your molecule is optimized and scored. New molecules score big, and one that's <b>not in PubChem</b> scores huge.</p>
  <p>One finger rotates, pinch zooms.</p>
  <p style="opacity:.8">Tap <b>?</b> at the top any time for the full guide and the interactive tutorial.</p>`;
  lessonBtn(card, '🌱 New to atoms and molecules? Take the 5-minute lesson');
  closeBtn(card, "Let's build!");
  const more = document.createElement('button'); more.className = 'link'; more.textContent = 'Show the full guide';
  more.onclick = () => { SFX.tick(); showHelp(); };
  card.appendChild(more);
}
function showHelp(){
  const card = openCard();
  card.innerHTML = `<h2>How to play</h2>
  <p>Build a molecule atom by atom, then hit <b>Build</b> (the flask). It gets optimized and scored.</p>`;
  lessonBtn(card, '🌱 Beginner lesson: atoms, electrons and bonds');
  const tut = document.createElement('button'); tut.className = 'try'; tut.style.margin = '8px 0 8px';
  tut.textContent = '🏫 Interactive tutorial: elements, shapes and a quiz';
  tut.onclick = () => { SFX.tick(); showLearn(); };
  card.appendChild(tut);
  card.insertAdjacentHTML('beforeend', `
  <p><b>➕ Add</b> — click an element button to drop an atom next to the molecule (it bonds automatically when close enough), or tap an atom to grow from it.</p>
  <p><b>Tap a bond</b> to change it: single → double → triple → single. On a computer, bonds light up when you hover.</p>
  <p><b>🔗 Bond</b> — tap two atoms to bond them. Tap the same pair again to cycle single → double → triple → none (great for rings).</p>
  <p><b>✋ Move</b> — drag atoms to perfect the geometry. The closer you are to the optimum, the more points.</p>
  <p><b>Delete</b> — tap an atom to remove it, or a bond to break it. <b>Undo</b> steps back one change, <b>Reset</b> starts over.</p>
  <p><b>H+</b> — saturates your molecule: every atom with free bonds gets hydrogens until it has its full valence (C 4, N 3, O 2, S 2). Build does this for you too.</p>
  <p><b>📏 Measure</b> — shows bond lengths (Å) on the bonds and the angles (°) around the atom you tap or drag, live as you move it. Typical values: C–H 1.09, C–C 1.54, C=C 1.34, C=O 1.21 Å; 109.5° around a carbon with four bonds, 120° with a double bond.</p>
  <p><b>Charges & radicals</b> — O can make a 3rd bond (N a 4th): QuMol gives it a + charge and a neighbor the −, like ⁻C≡O⁺. If bonds are left free when you Build, you can fill them with H or keep a radical (up to 2 unpaired electrons).</p>
  <p><b>XYZ</b> — shows the formula and coordinates as you build; edit the numbers to reshape the molecule directly.</p>
  <p><b>🧩 Puzzles</b> — you get a molecule's name, formula and SMILES; build it as close to its experimental 3D structure as you can, against the clock. Five daily puzzles from easy to hard, plus random ones. <b>Next puzzle</b> takes you straight to the next one you haven't solved. Leaderboards rank by puzzles solved, then total time. After you solve one, the experimental structure appears as a green outline over yours.</p>
  <p><b>🧙 Cauldron</b> — in the alchemy lab, tap C, N, O or H to drop atoms into the cauldron, one at a time (drag an atom to move it, tap it to scoop it out), set the temperature and the cooking time (15 fs to 1 ps), then press Cook. When it's done, sprinkle hydrogens on the free bonds and add the molecules to your collection. The atoms fly around, collide and bond on their own, simulated live with a reactive machine-learned potential. Pick a molecule from the pot: it gets hydrogens on every free bond, and you Build it like any other. Cooked molecules don't earn hand-built or geometry points, and have their own Chefs leaderboard.</p>
  <p><b>Points</b> — new QuMol formula +1000, new molecule (SMILES) +100, energy records, stable +50, hand-built +50, geometry skill up to +100, formal charges +50, <b>+20 for each bond type</b> in the molecule (C–H, C–C, C=C, C–O, …), and a huge bonus if it's <b>not in PubChem</b>: 1000 × 10^(3 / number of atoms), so the smaller the molecule, the bigger the prize (31,623 for 2 atoms, 10,000 for 3, 2,154 for 9). Molecules you already collected score 0.</p>
  <p style="opacity:.7">On a computer, hover over any button to see what it does. Loaded examples don't earn geometry or hand-built points; edited XYZ doesn't earn the hand-built bonus.</p>
  <p>One finger rotates, pinch zooms.</p>
  <p style="opacity:.6;font-size:13px">${!ONLINE || !SERVER.method || SERVER.method.name === 'toyff' ? 'Early prototype: energies come from a simple toy force field. A proper ML potential comes later.' : `Energies come from the ${SERVER.method.name === 'uma' ? 'UMA machine-learning potential' : escapeHTML(SERVER.method.name)} (${escapeHTML(SERVER.method.version || '')}).`}</p>
  <p class="verline">${versionText()}</p>`);
  closeBtn(card, "Let's build!");
}
/* ---------- badges: titles and icons come from qumol/badges.toml via /api/badges ---------- */
const badgeQueue = [];
let badgeShowing = false;
function badgesSeenKey(){ return 'qm.badges:' + (nick || ''); }
// Compare what the server says is earned with what this device has already celebrated.
function noteBadges(b){
  if(!b || !Array.isArray(b.earned)) return;
  const seen = LS.get(badgesSeenKey(), null);
  LS.set(badgesSeenKey(), b.earned);
  if(!Array.isArray(seen)){  // first look on this device: one summary instead of a pile of pop-ups
    if(b.earned.length) setTimeout(() => toast(`🏅 You have ${b.earned.length} badge${b.earned.length > 1 ? 's' : ''}! Open your collection to see them.`, 3200), 1200);
    return;
  }
  const all = [...b.ladders.flatMap(l => l.tiers.map(t => ({...t, ladder:l.name}))), ...b.badges];
  for(const k of b.earned) if(!seen.includes(k)){ const x = all.find(a => a.key === k); if(x) badgeQueue.push(x); }
  nextBadgePop();
}
function nextBadgePop(){
  if(badgeShowing || !badgeQueue.length) return;
  badgeShowing = true;
  const x = badgeQueue.shift(), el = $('badgePop');
  el.innerHTML = `<span class="bpi">${x.icon}</span><span><small>${x.ladder ? 'New title!' : 'Badge unlocked!'}</small><b>${escapeHTML(x.title)}</b>${x.ladder ? `<em>${escapeHTML(x.ladder)}</em>` : ''}</span>`;
  el.onclick = () => { el.classList.remove('show'); showBadges(); };
  setTimeout(() => { el.classList.add('show'); SFX.fanfare(); buzz([30, 40, 30]); }, 900);
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => { badgeShowing = false; nextBadgePop(); }, 400); }, 4600);
}
async function checkBadges(){
  if(!ONLINE || !token) return;
  try{ noteBadges(await api('/api/badges')); }catch{}
}
async function badgeEvent(event){
  if(!ONLINE || !token) return;
  try{ noteBadges(await api('/api/badges/event', {method:'POST', body:{event}})); }catch{}
}
async function showBadges(){
  if(ONLINE && !token) return showWelcome();
  let b;
  try{ b = await api('/api/badges'); }catch(e){ return toast(e.message); }
  noteBadges(b);
  const card = openCard(); card.classList.add('badges');
  card.innerHTML = `<h2>🏅 Badges · ${b.earned.length}</h2>`;
  for(const l of b.ladders){
    const next = l.tiers.find(t => !t.earned), top = [...l.tiers].reverse().find(t => t.earned);
    const prev = top ? top.at : 0, pct = next ? Math.min(100, 100 * (l.value - prev) / (next.at - prev)) : 100;
    const d = document.createElement('div'); d.className = 'bladder';
    d.innerHTML = `<div class="bl-h"><b>${escapeHTML(l.name)}</b><span>${l.value.toLocaleString()} ${escapeHTML(l.value === 1 ? l.unit.replace(/^(\w+)s\b/, '$1') : l.unit)}</span></div>
      <div class="bl-tiers">${l.tiers.map(t => `<span class="btier${t.earned ? ' on' : ''}" title="${escapeHTML(t.title)}: ${t.at.toLocaleString()} ${escapeHTML(l.unit)}">${t.icon}<small>${t.at.toLocaleString()}</small></span>`).join('')}</div>
      <div class="bl-bar"><i style="width:${pct}%"></i></div>
      <div class="bl-next">${top ? `${top.icon} <b>${escapeHTML(top.title)}</b>` : 'No title yet'}${next ? ` · next: ${next.icon} ${escapeHTML(next.title)} at ${next.at.toLocaleString()}` : ' · top tier!'}</div>`;
    card.appendChild(d);
  }
  const g = document.createElement('div'); g.className = 'bgrid';
  g.innerHTML = b.badges.map(x => `<div class="bbadge${x.earned ? ' on' : ''}"><span>${x.icon}</span><b>${x.earned ? escapeHTML(x.title) : '???'}</b><small>${escapeHTML(x.hint)}</small></div>`).join('');
  card.appendChild(g);
  const back = document.createElement('button'); back.className = 'link'; back.textContent = 'Back to my collection';
  back.onclick = () => showCollection(); card.appendChild(back);
  closeBtn(card, 'Close');
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
  const card = openCard(); card.classList.add('coll');
  const h = document.createElement('h2'); h.textContent = `${nick ? nick + ' · ' : 'Your collection · '}${total.toLocaleString()} ⭐`; card.appendChild(h);
  if(!items.length){ const p = document.createElement('p'); p.textContent = 'Nothing yet. Go build something!'; card.appendChild(p); }
  items.slice(0, 50).forEach(e => card.appendChild(lineEl((e.discovery ? '🤯 ' : '') + e.formula, e.score, e.smiles)));
  if(ONLINE){
    const bb = document.createElement('button'); bb.className = 'try'; bb.textContent = '🏅 My badges';
    bb.onclick = () => showBadges(); card.insertBefore(bb, h.nextSibling);
    const em = document.createElement('button'); em.className = 'link';
    em.textContent = email ? `Contact email: ${email} (change)` : 'Add a contact email (optional)';
    em.onclick = () => editEmail(email);
    card.appendChild(em);
    const out = document.createElement('button'); out.className = 'link'; out.textContent = 'Log out';
    out.onclick = () => confirmLogout();
    card.appendChild(out);
  }
  closeBtn(card, 'Close');
}
function confirmLogout(){
  const card = openCard();
  card.innerHTML = `<h2>Log out?</h2>
    <p>Your account and molecules stay safe on the server, but there's no password: to sign back in as <b>${escapeHTML(nick || '')}</b> you need your <b>recovery code</b> (the code shown when you picked your nickname).</p>
    <p>Without it you can't get this account back.</p>`;
  const go = document.createElement('button'); go.id = 'ovBtn'; go.textContent = 'I have my code, log out';
  const back = document.createElement('button'); back.className = 'link'; back.textContent = 'Cancel';
  card.append(go, back);
  go.onclick = () => {
    setAccount(null, null); total = 0; LS.set('qm.total', 0); updateInfo();
    SFX.tick(); showWelcome();
  };
  back.onclick = () => showCollection();
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
  if(!LS.get('qm.seenHelp', false)){ LS.set('qm.seenHelp', true); $('ovBtn').onclick = () => showIntro(); }
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
    <p>You get the name, formula and SMILES. Build it by hand, as close to its <b>experimental 3D structure</b> as you can; the clock starts when you open the puzzle. Use 📏 Measure to check bond lengths and angles. Leaderboards rank by puzzles solved, then by total time. Your first solve of each puzzle counts.</p>
    <h3 class="pzday"></h3><div class="pzlist"></div>`;
  const allDone = d.puzzles.length && d.puzzles.every(p => p.solved_score !== null && p.solved_score !== undefined);
  card.querySelector('.pzday').textContent = `Today's puzzles · ${d.day}${allDone ? ' · 🎉 all solved!' : ''}`;
  const list = card.querySelector('.pzlist');
  for(const p of d.puzzles){
    const done = p.solved_score !== null && p.solved_score !== undefined;
    const row = lineEl(`${p.slot}. ${p.name}`, done ? '✓ solved' : `${p.heavy} heavy`, null, done ? 'me' : '');
    const f = document.createElement('small'); formulaInto(f, p.formula);
    const smi = document.createElement('span'); smi.className = 'smi'; smi.textContent = p.smiles;
    f.append('  ·  ', smi, p.note ? '  ·  ' + p.note : '');
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

// Straight to the next puzzle: the next unsolved daily one after this one (a random run
// continues with random ones), or a card saying everything is solved.
async function nextPuzzle(){
  let d;
  try{ d = await api('/api/puzzles/daily'); }catch(e){ return toast(e.message); }
  if(puzzle && !puzzle.daily) return d.unsolved > 0 ? startPuzzle({}) : showAllSolved(d, true);
  const list = d.puzzles, i = list.findIndex(p => puzzle && p.id === puzzle.info.id);
  const p = [...list.slice(i + 1), ...list.slice(0, i + 1)].find(p => p.solved_score === null || p.solved_score === undefined);
  if(p) return startPuzzle({puzzle_id: p.id, daily: true});
  showAllSolved(d, false);
}
function showAllSolved(d, everything){
  const card = openCard();
  card.innerHTML = `<h2>🎉 All puzzles solved!</h2><p style="text-align:center"></p>`;
  card.querySelector('p').textContent = everything
    ? `You've solved all ${d.total_puzzles} puzzles in QuMol. Amazing!`
    : `You've solved all ${d.puzzles.length} of today's puzzles. New ones arrive tomorrow.`;
  SFX.chime(); buzz(30);
  if(!everything && d.unsolved > 0){
    const rnd = document.createElement('button'); rnd.id = 'ovBtn';
    rnd.textContent = `🎲 Random puzzle (${d.unsolved} not solved yet)`;
    rnd.onclick = () => startPuzzle({});
    card.appendChild(rnd);
  }
  const lb = document.createElement('button'); lb.className = 'link'; lb.textContent = '🏆 Puzzle leaderboards';
  lb.onclick = () => showLeaderboard('puzzle_daily');
  const out = document.createElement('button'); out.className = 'link'; out.textContent = 'Back to free building';
  out.onclick = () => { $('ov').classList.add('hidden'); exitPuzzle(); };
  card.append(lb, out);
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
let puzzleSaved = null, xyzBefore = false;
function setPuzzleUI(on){
  $('puzzleBar').classList.toggle('hidden', !on);
  document.body.classList.toggle('puzzling', on);
  $('submitLabel').textContent = on ? 'Check' : 'Build';
  if(on){ xyzBefore = xyzOpen; setXYZOpen(false, false); }  // 📏 Measure stays available: it helps get lengths and angles right
  else setXYZOpen(xyzBefore);
  if(on) setPlotOpen(false);
  for(const id of ['xyzBtn', 'plotBtn']){ $(id).classList.toggle('disabled', on); $(id).disabled = on; }
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
  if(typeof r.total === 'number'){ total = r.total; LS.set('qm.total', total); $('total').textContent = `${total.toLocaleString()} ⭐`; checkBadges(); }  // puzzle points count toward the total
  if(r.score > 0){ SFX.chime(); buzz(30); burst(centroid(), [0x7c5cff, 0x20d3a7, 0xffffff], 50, 4, 0.9, 0.3); }
  const src = document.createElement('div'); src.className = 'src';
  src.textContent = `Reference structure: ${(r.source && r.source.text) || ''}${r.source && r.source.doi ? ', doi:' + r.source.doi : ''}`;
  card.appendChild(src);
  const cmp = document.createElement('button'); cmp.id = 'ovBtn'; cmp.textContent = 'Compare in 3D';
  cmp.onclick = () => { $('ov').classList.add('hidden'); toast('Green outline: the experimental structure', 3000); };
  const next = document.createElement('button'); next.className = 'link'; next.textContent = '🧩 Next puzzle';
  next.onclick = () => { SFX.tick(); nextPuzzle(); };
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

/* ================= cooking mode ================= */
// The kitchen: drop C, N and O atoms into a cauldron one by one (each lands at a random
// spot), drag them around, set the heat, then Cook. The server runs reactive molecular dynamics from exactly
// those positions while the atoms move here live, and bonds form on their own. Each
// molecule in the pot comes back saturated with H; the player picks one and builds it like
// any other (input method 'cook': no hand-built or geometry points).
const COOK_ELS = ['C', 'N', 'O', 'H'], COOK_MAX = 10, COOK_MIN = 2;  // COOK_MAX counts heavy atoms
const COOK_MASS = {C:12.011, N:14.007, O:15.999, H:1.008};
let cooking = false, simmering = false, cookSaved = null, cookXYZ = false;
let cookTemp = Math.min(3000, Math.max(300, Number(LS.get('qm.cookTemp', 1500)) || 1500));
let potHeat = 300;  // what the glow and the bubbles show right now
const potR = n => Math.max(3, Math.cbrt(3 * 12 * Math.max(1, n) / (4 * Math.PI)));  // = beaker_radius on the server
const POT_S = 4.0;  // the cauldron's size in Å (the beaker wall is at ~3 Å)
const POT_VIEW = new THREE.Vector3(0, -0.42 * POT_S, 0);  // look a bit low so the pot sits above the kitchen tray
const heatColor = (T, cool, hot) => new THREE.Color(cool).lerp(new THREE.Color(hot), Math.min(1, Math.max(0, (T - 300) / 2700)));
const heat01 = T => Math.min(1, Math.max(0, (T - 300) / 2700));
const tempWord = T => T < 700 ? 'simmer' : T < 1300 ? 'boil' : T < 2200 ? 'roaring' : 'dragon fire';

// --- the cauldron: see-through iron so the atoms stay visible, glowing from inside as it heats
const pot = new THREE.Group(); pot.visible = false; world.add(pot);
const ironMat = new THREE.MeshStandardMaterial({color:0x3a3f4d, metalness:0.75, roughness:0.45,
  transparent:true, opacity:0.42, side:THREE.DoubleSide, depthWrite:false});
const ironSolid = new THREE.MeshStandardMaterial({color:0x2c303b, metalness:0.8, roughness:0.4, emissive:0x000000});
{
  const prof = [[0.001,-0.95],[0.5,-0.92],[0.88,-0.75],[1.1,-0.45],[1.17,-0.1],[1.12,0.25],[0.98,0.55],[0.87,0.72],[0.85,0.8]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  pot.add(new THREE.Mesh(new THREE.LatheGeometry(prof, 48), ironMat));
  const rimG = new THREE.TorusGeometry(0.88, 0.07, 12, 48); rimG.rotateX(Math.PI / 2);
  const rimM = new THREE.Mesh(rimG, ironSolid); rimM.position.y = 0.82; pot.add(rimM);
  for(const s of [-1, 1]){  // handles
    const h = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.035, 8, 20), ironSolid);
    h.position.set(s * 1.06, 0.4, 0); h.rotation.y = Math.PI / 2; pot.add(h);
  }
  for(let k = 0; k < 3; k++){  // stubby legs
    const a = k * 2 * Math.PI / 3 + 0.4, leg = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.04, 0.32, 8), ironSolid);
    leg.position.set(0.62 * Math.cos(a), -0.98, 0.62 * Math.sin(a)); leg.rotation.z = 0.25 * Math.cos(a); leg.rotation.x = -0.25 * Math.sin(a);
    pot.add(leg);
  }
}
const potLight = new THREE.PointLight(0x37ff9a, 1.2, 14, 1.5); potLight.position.set(0, 0.2, 0); pot.add(potLight);
// bubbles rising through the brew while it cooks (pot units)
function pool(n, size){
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const pts = new THREE.Points(g, new THREE.PointsMaterial({size, map:dotTex, vertexColors:true, transparent:true,
    depthWrite:false, blending:THREE.AdditiveBlending}));
  pts.userData.p = Array.from({length:n}, () => ({life:0, age:1, x:0, y:0, z:0, vx:0, vy:0, vz:0}));
  pot.add(pts); return pts;
}
const bubbles = pool(60, 0.4);
const _c = new THREE.Color();
function stepPool(pts, dt, spawnRate, spawn, color){
  const P = pts.userData.p, pos = pts.geometry.attributes.position.array, col = pts.geometry.attributes.color.array;
  let want = spawnRate * dt;
  P.forEach((q, i) => {
    q.age += dt;
    if(q.age >= q.life && (want >= 1 || Math.random() < want)){ want--; spawn(q); q.age = 0; }
    const alive = q.age < q.life, f = alive ? q.age / q.life : 1;
    q.x += q.vx * dt; q.y += q.vy * dt; q.z += q.vz * dt;
    pos[3*i] = q.x; pos[3*i+1] = alive ? q.y : -99; pos[3*i+2] = q.z;
    color(f, _c); const fade = alive ? 1 - f : 0;
    col[3*i] = _c.r * fade; col[3*i+1] = _c.g * fade; col[3*i+2] = _c.b * fade;
  });
  pts.geometry.attributes.position.needsUpdate = true; pts.geometry.attributes.color.needsUpdate = true;
}
function updatePot(dt, now){
  if(!pot.visible) return;
  const h = heat01(potHeat);
  const bubCol = heatColor(potHeat, 0x7dffb8, 0xffb36b);
  stepPool(bubbles, dt, simmering ? 4 + 30 * h : 0, q => {
    const a = Math.random() * 2 * Math.PI, r = Math.random() * 0.75;
    q.x = r * Math.cos(a); q.z = r * Math.sin(a); q.y = -0.6 + Math.random() * 0.4;
    q.vx = (Math.random() - 0.5) * 0.1; q.vz = (Math.random() - 0.5) * 0.1; q.vy = 0.5 + 0.8 * h + Math.random() * 0.3;
    q.life = 1.4 + Math.random();
  }, (f, c) => c.copy(bubCol));
  potLight.color.copy(heatColor(potHeat, 0x37ff9a, 0xff7a2e)); potLight.intensity = 0.8 + 1.6 * h;
  ironSolid.emissive.copy(heatColor(potHeat, 0x000000, 0x5a1500)).multiplyScalar(h);
  // atoms dropping in: fall through the mouth, splash where they land
  let moving = false;
  atoms.forEach(a => {
    if(!a.drop) return;
    const t = Math.min(1, Math.max(0, (now - a.drop.t0) / a.drop.ms));
    a.p.lerpVectors(a.drop.from, a.drop.to, t * t);
    moving = true;
    if(t >= 1){
      const land = a.drop.onLand; a.p.copy(a.drop.to); delete a.drop;
      if(land) land();
      else { burst(a.p.clone(), [0x9dffd0, 0x37ff9a, 0xffffff], 16, 2.2, 0.45, 0.16, 3); CSFX.splash(a.el); }
    }
  });
  if(moving) rebuild();
}

// A fixed view of the cauldron from the front, a little above, far enough back that it all
// fits whichever way the screen is turned. The camera stays put while you fill the pot and
// cook; once the brew is done you can drag to turn it around (see potOrbit).
let cookCam = null;
function kitchenCamera(R){
  if(!cookCam) cookCam = {p:camera.position.clone(), t:controls.target.clone()};
  const v = THREE.MathUtils.degToRad(camera.fov) / 2, half = Math.min(v, Math.atan(Math.tan(v) * camera.aspect));
  controls.enableDamping = false; controls.update(); controls.enableDamping = true;  // drop any spin left over from orbiting
  controls.target.copy(POT_VIEW); controls.enabled = false; potOrbitOff();
  camera.position.copy(POT_VIEW).add(new THREE.Vector3(0, 0.3, 1).setLength(1.15 * R / Math.sin(half)));
  camera.lookAt(POT_VIEW);
}
const canOrbitPot = () => cooking && !simmering && phase !== 'prep';
// Spin all the way round, but tilt only so far, so the pot doesn't swing up under the top bar.
function potOrbit(){ controls.target.copy(POT_VIEW); controls.minPolarAngle = 0.8; controls.maxPolarAngle = 1.8; controls.enabled = true; }
function potOrbitOff(){ controls.minPolarAngle = 0; controls.maxPolarAngle = Math.PI; }
// Keep a dragged atom inside the beaker and not on top of another atom.
function settleInPot(i){
  const a = atoms[i], R = potR(atoms.length) - 0.2;
  for(let pass = 0; pass < 4; pass++){
    for(let j = 0; j < atoms.length; j++){
      if(j === i) continue;
      const d = a.p.clone().sub(atoms[j].p), L = d.length();
      if(L < 1.2) a.p.add((L > 1e-6 ? d : randUnit()).setLength(1.2 - L + 1e-3));
    }
    if(a.p.length() > R) a.p.setLength(R);
  }
}
// Bonds in the pot are just "close enough" (1.2 × covalent radii), drawn as single bonds.
function potBonds(){
  const out = [];
  for(let i=0;i<atoms.length;i++) for(let j=i+1;j<atoms.length;j++)
    if(atoms[i].p.distanceTo(atoms[j].p) < 1.2 * (EL[atoms[i].el].r + EL[atoms[j].el].r)) out.push({a:i, b:j, o:1});
  return out;
}

/* --- cauldron sounds: all synthesized, on their own bus with a soft compressor --- */
let cbus = null, noiseBuf = null;
function bus(){
  if(!ac) return null;
  if(!cbus){
    const comp = ac.createDynamicsCompressor(); comp.threshold.value = -18; comp.ratio.value = 4;
    cbus = ac.createGain(); cbus.gain.value = 0.9; cbus.connect(comp).connect(ac.destination);
    const len = ac.sampleRate * 2; noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
    const d = noiseBuf.getChannelData(0); for(let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  return cbus;
}
function env(g, t, a, peak, d){ g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); }
function osc(type, f, t, dur, peak, f2 = null, a = 0.005, dest = null){
  const o = ac.createOscillator(), g = ac.createGain(); o.type = type;
  o.frequency.setValueAtTime(f, t); if(f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
  env(g, t, a, peak, dur); o.connect(g).connect(dest || cbus); o.start(t); o.stop(t + a + dur + 0.05); return o;
}
function noise(t, dur, peak, type, f, f2 = null, q = 1, a = 0.005){
  const s = ac.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
  const fl = ac.createBiquadFilter(); fl.type = type; fl.Q.value = q;
  fl.frequency.setValueAtTime(f, t); if(f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur);
  const g = ac.createGain(); env(g, t, a, peak, dur);
  s.connect(fl).connect(g).connect(cbus); s.start(t, Math.random()); s.stop(t + a + dur + 0.05);
}
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
const note = k => 392 * Math.pow(2, PENTA[Math.min(PENTA.length - 1, k)] / 12);
const ELPITCH = {C:1, N:1.19, O:1.41, H:1.78};
const CSFX = {
  ok(){ return !muted && bus(); },
  // a cartoon whistle as the atom falls in
  drop(el){ if(!this.ok()) return; const t = ac.currentTime, k = ELPITCH[el] || 1;
    osc('sine', 1500 * k, t, 0.36, 0.05, 520 * k, 0.02); },
  // the splash: a low thump, a water "bloop" with rising pitch, and a spray of noise
  splash(el){ if(!this.ok()) return; const t = ac.currentTime, k = ELPITCH[el] || 1;
    osc('sine', 150, t, 0.16, 0.35, 55);
    osc('sine', 260 * k, t + 0.01, 0.12, 0.3, 900 * k, 0.004);
    osc('sine', 390 * k, t + 0.09, 0.09, 0.14, 1200 * k, 0.004);
    noise(t, 0.22, 0.12, 'bandpass', 1800, 600, 0.8);
    for(let i = 0; i < 3; i++) osc('sine', 900 + 900 * Math.random(), t + 0.12 + 0.05 * i + 0.04 * Math.random(), 0.05, 0.05, 2400, 0.003); },
  // scooping an atom back out: a rising slurp
  scoop(){ if(!this.ok()) return; const t = ac.currentTime;
    osc('triangle', 220, t, 0.28, 0.16, 880, 0.03); noise(t, 0.25, 0.06, 'bandpass', 500, 2500, 3); },
  // the salt shaker: three quick rattles
  shake(){ if(!this.ok()) return; const t = ac.currentTime;
    for(let i = 0; i < 4; i++) noise(t + 0.11 * i, 0.07, 0.16, 'bandpass', 4200, 2600, 2, 0.004); },
  // a hydrogen lands: a bright tink, climbing a scale, with a few grains
  salt(k){ if(!this.ok()) return; const t = ac.currentTime, f = note((k % 8) + 3) * 2;
    osc('sine', f, t, 0.16, 0.09, null, 0.003); osc('sine', f * 2.4, t, 0.07, 0.025, null, 0.003);
    noise(t, 0.03, 0.04, 'highpass', 6000); },
  grab(){ if(!this.ok()) return; const t = ac.currentTime; osc('sine', 500, t, 0.08, 0.1, 800, 0.004); },
  place(el){ if(!this.ok()) return; const t = ac.currentTime, k = ELPITCH[el] || 1;
    osc('sine', 240 * k, t, 0.09, 0.2, 700 * k, 0.004); noise(t, 0.08, 0.04, 'bandpass', 1500, 700, 1); },
  empty(){ if(!this.ok()) return; const t = ac.currentTime;
    noise(t, 0.6, 0.18, 'lowpass', 3000, 200, 1, 0.02); osc('sine', 300, t, 0.5, 0.12, 60); },
  full(){ if(!this.ok()) return; const t = ac.currentTime; osc('square', 180, t, 0.09, 0.06); osc('square', 140, t + 0.11, 0.12, 0.06); },
  // lighting the fire for the cook: a big whoosh up into a roar, and a magical chord
  ignite(){ if(!this.ok()) return; const t = ac.currentTime;
    noise(t, 1.1, 0.4, 'bandpass', 180, 2600, 1.2, 0.25); osc('sawtooth', 70, t, 1.0, 0.1, 40, 0.1);
    [0, 4, 7, 12].forEach((s, i) => osc('triangle', 196 * Math.pow(2, s / 12), t + 0.25 + 0.07 * i, 0.9, 0.05, null, 0.05)); },
  // a new bond: bubble pop plus a bell, climbing a pentatonic scale bond by bond
  bond(k){ if(!this.ok()) return; const t = ac.currentTime, f = note(k);
    osc('sine', 300, t, 0.07, 0.18, 1100, 0.003);
    osc('sine', f, t + 0.03, 0.55, 0.14, null, 0.004); osc('sine', 2.76 * f, t + 0.03, 0.25, 0.04, null, 0.004);
    noise(t, 0.05, 0.05, 'highpass', 4000); },
  unbond(){ if(!this.ok()) return; const t = ac.currentTime; osc('triangle', 500, t, 0.18, 0.06, 160); noise(t, 0.15, 0.04, 'highpass', 2500); },
  // the potion is ready: a puff of steam and a sparkling arpeggio
  done(){ if(!this.ok()) return; const t = ac.currentTime;
    noise(t, 0.7, 0.2, 'lowpass', 900, 300, 1, 0.03);
    [0, 2, 4, 5, 7, 8, 9, 10].forEach((k, i) => { osc('sine', note(k), t + 0.2 + 0.07 * i, 0.5, 0.11); osc('sine', 2 * note(k), t + 0.2 + 0.07 * i, 0.3, 0.03); });
    osc('triangle', note(10), t + 0.85, 1.2, 0.1); osc('triangle', note(7), t + 0.85, 1.2, 0.07); osc('triangle', note(5), t + 0.85, 1.2, 0.06); },
};
// The cook's ambient sound: a low rumble, bubbles and a drone, all following the heat.
// Starts when the player presses Cook and stops when the brew is done.
const ambience = {
  on:false, fire:null, fireF:null, drone:null, droneF:null, timer:null, level:1,
  start(){
    if(this.on || !bus()) return; this.on = true;
    const t = ac.currentTime;
    const s = ac.createBufferSource(); s.buffer = noiseBuf; s.loop = true;
    this.fireF = ac.createBiquadFilter(); this.fireF.type = 'lowpass'; this.fireF.frequency.value = 500;
    this.fire = ac.createGain(); this.fire.gain.setValueAtTime(0.0001, t);
    s.connect(this.fireF).connect(this.fire).connect(cbus); s.start(); this.src = s;
    this.droneF = ac.createBiquadFilter(); this.droneF.type = 'lowpass'; this.droneF.frequency.value = 200; this.droneF.Q.value = 6;
    this.drone = ac.createGain(); this.drone.gain.setValueAtTime(0.0001, t);
    this.oscs = [55, 55.4, 82.4].map(f => { const o = ac.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.connect(this.droneF); o.start(); return o; });
    this.droneF.connect(this.drone).connect(cbus);
    this.timer = setInterval(() => this.tick(), 60);
    this.update();
  },
  update(){
    if(!this.on) return;
    const h = heat01(potHeat), t = ac.currentTime, m = muted ? 0.0001 : 1, L = this.level;
    this.fire.gain.setTargetAtTime(Math.max(0.0001, m * L * (0.05 + 0.16 * h)), t, 0.15);
    this.fireF.frequency.setTargetAtTime(350 + 1500 * h, t, 0.2);
    this.drone.gain.setTargetAtTime(Math.max(0.0001, m * L * (0.04 + 0.05 * h)), t, 0.3);
    this.droneF.frequency.setTargetAtTime(140 + 500 * h, t, 0.3);
  },
  tick(){
    if(muted || !ac) return;
    const h = heat01(potHeat), t = ac.currentTime, L = this.level;
    if(Math.random() < (0.25 + 1.2 * h) * L){  // a bubble blips
      const f = 180 + 420 * Math.random();
      osc('sine', f, t, 0.05 + 0.05 * Math.random(), (0.04 + 0.06 * Math.random()) * L, f * (2 + Math.random()), 0.003);
    }
  },
  stop(){
    if(!this.on) return; this.on = false; clearInterval(this.timer);
    const t = ac.currentTime, f = this.fire, d = this.drone, src = this.src, oscs = this.oscs;
    f.gain.setTargetAtTime(0.0001, t, 0.2); d.gain.setTargetAtTime(0.0001, t, 0.2);
    setTimeout(() => { try{ src.stop(); oscs.forEach(o => o.stop()); f.disconnect(); d.disconnect(); }catch{} }, 1200);
  },
};

/* --- the kitchen tray --- */
// Phases: 'prep' (fill the pot, set temperature and time, Cook; 'simmering' while it runs),
// 'salt' (the brew is done: sprinkle H on the free bonds?), 'serve' (add the molecules?).
const kitchen = $('kitchen');
const COOK_TIMES = [15, 25, 50, 100, 200, 300, 500, 750, 1000];  // fs
let cookFs = COOK_TIMES.includes(+LS.get('qm.cookFs', 500)) ? +LS.get('qm.cookFs', 500) : 500;
let phase = 'prep', lastCook = null;
const COOK_MAX_H = 10;
const canEditPot = () => cooking && !simmering && phase === 'prep';
const heavyIn = () => atoms.filter(a => a.el !== 'H').length;
const hIn = () => atoms.length - heavyIn();
function kitchenTray(){
  if(cooking && phase !== 'prep') kitchenCamera(POT_S * 1.75);  // back to the front view for filling
  kitchen.innerHTML = ''; kitchen.dataset.phase = phase = 'prep';
  const jars = document.createElement('div'); jars.className = 'kjars kprep';
  for(const el of COOK_ELS){
    const b = document.createElement('button'); b.className = 'kjar'; b.dataset.el = el;
    b.style.setProperty('--ec', '#' + EL[el].c.toString(16).padStart(6, '0'));
    b.setAttribute('aria-label', `Drop a ${EL[el].name.toLowerCase()} atom in the cauldron`);
    b.innerHTML = `<span class="kball">${el}</span><span class="kname">${EL[el].name}</span><span class="kcnt"></span>`;
    b.onclick = () => { unlockAudio(); addIngredient(el); };
    jars.appendChild(b);
  }
  const heat = document.createElement('div'); heat.className = 'kfire kprep';
  heat.innerHTML = `<label for="cookT">🌡️ Temperature</label><input type="range" id="cookT" min="300" max="3000" step="100" aria-label="Temperature in kelvin"><b id="cookTval"></b>`;
  const time = document.createElement('div'); time.className = 'kfire kprep';
  time.innerHTML = `<label for="cookFs">⏳ Time</label><input type="range" id="cookFs" min="0" max="${COOK_TIMES.length - 1}" step="1" aria-label="Cooking time in femtoseconds"><b id="cookFsval"></b>`;
  const timer = document.createElement('div'); timer.className = 'ktimer';
  timer.innerHTML = `<span class="hg">⏳</span><div class="kbar"><i id="kbarFill"></i></div><b id="ktime">0 fs</b>`;
  const acts = document.createElement('div'); acts.className = 'kacts kprep';
  const mk = (id, html, tip, fn) => { const b = document.createElement('button'); b.id = id; b.innerHTML = html; b.dataset.tip = tip; b.onclick = () => { unlockAudio(); fn(); }; acts.appendChild(b); return b; };
  mk('kLeave', '✕', 'Leave the kitchen and go back to your molecule', leaveKitchen).setAttribute('aria-label', 'Leave the kitchen');
  mk('kOut', '↶<span class="kt"> Take out</span>', 'Scoop out the last atom you dropped in (or tap any atom in the pot; drag one to move it)', () => removeIngredient(atoms.length - 1));
  mk('kEmpty', 'Empty', 'Pour everything out', emptyPot);
  mk('kCook', `${POT_SVG}<span>Cook!</span>`, 'Heat the cauldron: the atoms fly around, collide and bond on their own', cookNow).className = 'ico';
  mk('kLb', '🏆', 'Chefs leaderboard', () => showLeaderboard('cook')).setAttribute('aria-label', 'Chefs leaderboard');
  const done = document.createElement('div'); done.id = 'kdone';
  kitchen.append(jars, heat, time, timer, acts, done);
  const slider = $('cookT'); slider.value = cookTemp;
  let lastTick = 0;
  slider.oninput = () => {
    cookTemp = +slider.value; potHeat = cookTemp; LS.set('qm.cookTemp', cookTemp); showTemp();
    const now = performance.now();
    if(now - lastTick > 70 && CSFX.ok()){ lastTick = now; osc('sine', 300 + 900 * heat01(cookTemp), ac.currentTime, 0.05, 0.06); }
  };
  const ts = $('cookFs'); ts.value = COOK_TIMES.indexOf(cookFs);
  ts.oninput = () => {
    cookFs = COOK_TIMES[+ts.value]; LS.set('qm.cookFs', cookFs); showTemp();
    if(CSFX.ok()) osc('triangle', 1400 - 50 * +ts.value, ac.currentTime, 0.04, 0.07);  // a clock tick
  };
  showTemp(); refreshKitchen();
}
function showTemp(){
  const v = $('cookTval'); if(!v) return;
  v.textContent = `${cookTemp} K · ${tempWord(cookTemp)}`;
  v.style.color = '#' + heatColor(cookTemp, 0x9fffd0, 0xff8a3d).getHexString();
  $('cookFsval').textContent = cookFs >= 1000 ? '1 ps' : `${cookFs} fs`;
}
function refreshKitchen(){
  if(phase !== 'prep') return;
  const n = atoms.length, nh = heavyIn(), nH = n - nh;
  kitchen.querySelectorAll('.kjar').forEach(b => {
    const k = atoms.filter(a => a.el === b.dataset.el).length;
    b.querySelector('.kcnt').textContent = k ? `×${k}` : '';
    b.disabled = simmering || (b.dataset.el === 'H' ? nH >= COOK_MAX_H : nh >= COOK_MAX);
  });
  for(const id of ['kOut', 'kEmpty']) $(id).disabled = !n || simmering;
  $('kCook').disabled = n < COOK_MIN || !nh || simmering;
  $('kLeave').disabled = $('kLb').disabled = $('cookT').disabled = $('cookFs').disabled = simmering;
  if(!simmering){
    $('info').textContent = n < COOK_MIN || !nh
      ? `🧙 Cauldron · drop in at least ${COOK_MIN} atoms (C, N or O, plus H if you like)`
      : `🧙 ${formula()} in the cauldron · drag atoms to move them, tap to scoop one out`;
  }
}

// A random spot inside the beaker, away from the atoms already in it.
function potSpot(){
  const R = potR(heavyIn() + 1) - 0.35;
  for(const md of [2.0, 1.7, 1.4, 1.1]){
    for(let k = 0; k < 400; k++){
      const p = new THREE.Vector3(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1).multiplyScalar(R);
      if(p.length() <= R && atoms.every(a => (a.drop ? a.drop.to : a.p).distanceTo(p) >= md)) return p;
    }
  }
  return null;
}
function addIngredient(el){
  if(!canEditPot()) return;
  if(el === 'H' ? hIn() >= COOK_MAX_H : heavyIn() >= COOK_MAX){
    CSFX.full(); return toast(el === 'H' ? `At most ${COOK_MAX_H} hydrogens` : `The cauldron is full (${COOK_MAX} heavy atoms)`);
  }
  const to = potSpot(); if(!to){ CSFX.full(); return toast('No room left in the cauldron'); }
  const from = new THREE.Vector3(to.x * 0.25, POT_S * 1.7, to.z * 0.25);
  atoms.push({el, p:from.clone(), born:performance.now(), drop:{from, to, t0:performance.now(), ms:420}});
  CSFX.drop(el); buzz(8); rebuild(); refreshKitchen();
}
function removeIngredient(i){
  if(!canEditPot() || i < 0 || i >= atoms.length) return;
  const a = atoms[i];
  burst((a.drop ? a.drop.to : a.p).clone(), [0x9dffd0, 0xffffff], 12, 2, 0.4, 0.14);
  atoms.splice(i, 1); bonds = []; CSFX.scoop(); rebuild(); refreshKitchen();
}
function emptyPot(){
  if(!cooking || simmering || !atoms.length){ if(cooking && phase !== 'prep') kitchenTray(); return; }
  atoms.forEach(a => burst(a.p.clone(), [0x9dffd0, 0x37ff9a], 6, 2.5, 0.5, 0.14, 2));
  atoms = []; bonds = []; CSFX.empty(); rebuild();
  if(phase !== 'prep') kitchenTray(); else refreshKitchen();
}

function showCook(){
  if(!ONLINE) return toast('Cooking needs the QuMol server');
  if(!token) return showWelcome();
  if(puzzle) return toast('Leave the puzzle first (✕ at the top)');
  if(cooking) return simmering || addingMols ? null : leaveKitchen();
  if(busy) return;
  cookSaved = serialize();  // the player's own molecule comes back when they leave
  busy = true; cooking = true; bondFirst = null; document.body.classList.add('cooking');
  atoms = []; bonds = []; clearGhost(); setPlotOpen(false); rebuild();
  cookXYZ = xyzOpen; setXYZOpen(false, false);
  potHeat = cookTemp; pot.scale.setScalar(POT_S); pot.visible = true;
  scene.background = null; scene.getObjectByName('stars').visible = false;  // the alchemy lab shows through
  kitchenCamera(POT_S * 1.75);
  kitchenTray(); kitchen.classList.remove('hidden');
  if(!LS.get('qm.seenKitchen', false)){ LS.set('qm.seenKitchen', true); toast('Tap C, N, O or H to drop atoms in, drag them where you like, set the temperature and time, then Cook!', 5000); }
}
// Put the same ingredients back in, each at a new random spot, one after another.
function refill(els){
  if(phase !== 'prep') kitchenTray();
  atoms = []; bonds = []; rebuild(); refreshKitchen();
  els.forEach((el, i) => setTimeout(() => { if(canEditPot()) addIngredient(el); }, 140 * i));
}

async function cookNow(){
  if(!canEditPot() || atoms.length < COOK_MIN || !heavyIn()) return;
  atoms.forEach(a => { if(a.drop){ a.p.copy(a.drop.to); delete a.drop; } });
  const start = atoms.map(a => ({el:a.el, x:+a.p.x.toFixed(3), y:+a.p.y.toFixed(3), z:+a.p.z.toFixed(3)}));
  const els = atoms.map(a => a.el);
  simmering = true; document.body.classList.add('busy', 'simmer'); refreshKitchen();
  $('info').textContent = `🧪 Cooking ${formula()} at ${cookTemp} K for ${cookFs} fs`;
  $('kbarFill').style.width = '0%'; $('ktime').textContent = `0 / ${cookFs} fs`;
  const box = $('optInfo'); box.classList.remove('hidden'); box.textContent = 'Heating the cauldron…';
  CSFX.ignite(); potHeat = 300; ambience.start();  // the bubbling starts with the cook
  let lastBonds = 0, lastPop = 0, chain = 0;
  const onEvent = ev => {
    if(ev.type === 'start'){
      // the server keeps the wall on the centre of mass, so draw the pot around it
      const x = ev.coords, m = ev.symbols.map(e => COOK_MASS[e] || 12), M = m.reduce((s, v) => s + v, 0);
      const c = [0, 1, 2].map(d => x.reduce((s, p, i) => s + m[i] * p[d], 0) / M);
      setCoords(x.map(p => p.map((v, d) => v - c[d])).flat()); rebuild();
      box.textContent = `${ev.symbols.length} atoms · heating to ${ev.temp} K`;
    } else if(ev.type === 'frame'){
      if(ev.coords.length !== atoms.length) return;
      setCoords(ev.coords.flat()); bonds = potBonds(); rebuild();
      potHeat = ev.quench ? 300 : Math.max(300, ev.temp_set); ambience.update();
      const tf = ev.t_fs ?? ev.t_ps * 1000;
      $('kbarFill').style.width = `${Math.min(100, 100 * tf / cookFs)}%`;
      $('ktime').textContent = ev.quench ? 'cooling…' : `${Math.round(tf)} / ${cookFs} fs`;
      const now = performance.now();
      if(bonds.length > lastBonds && now - lastPop > 160){
        const b = bonds[bonds.length - 1];
        burst(atoms[b.a].p.clone().add(atoms[b.b].p).multiplyScalar(0.5), [0xffd166, 0xff8a3d, 0xffffff], 16, 2.2, 0.45, 0.18);
        CSFX.bond(chain++); lastPop = now; buzz(10);
      } else if(bonds.length < lastBonds && now - lastPop > 250){ CSFX.unbond(); lastPop = now; }
      lastBonds = bonds.length;
      box.textContent = ev.quench ? `Cooling down · ${ev.pot}`
        : `${Math.round(tf)} fs · target ${ev.temp_set} K · atoms at ${ev.temp_kin} K · ${ev.pot}`;
    }
  };
  let r = null;
  try{
    for(let attempt = 0; ; attempt++){
      try{ r = await apiStream('/api/cook/stream', {atoms:start, temp:cookTemp, duration_fs:cookFs}, onEvent); break; }
      catch(e){
        if(e.status === 401){ simmerOff(); leaveKitchen(); setAccount(null, null); showWelcome(); return; }
        if(e.status === 503 && attempt < 4 && !/set up/.test(e.message)){ toast('Server busy, retrying…', 3000); await sleep(1500 * (attempt + 1)); continue; }
        simmerOff(); fail(e.message || 'Could not reach the server'); refill(els); return;
      }
    }
  } finally { setTimeout(() => box.classList.add('hidden'), 1500); }
  simmerOff(); potHeat = cookTemp;
  burst(new THREE.Vector3(0, POT_S * 0.9, 0), [0xffffff, 0x9dffd0, 0xffd166], 50, 3, 1.2, 0.3, -1.5); CSFX.done();
  lastCook = {r, els};
  saltPhase(r);
}
function simmerOff(){ simmering = false; document.body.classList.remove('busy', 'simmer'); ambience.stop(); if(cooking) refreshKitchen(); }

// The done panel replaces the prep rows in the tray; the pot stays in view.
function donePanel(html, buttons){
  phase = kitchen.dataset.phase = buttons.phase;
  potOrbit();  // the brew is done: drag to turn it around
  const d = $('kdone'); d.innerHTML = '';
  const msg = document.createElement('div'); msg.className = 'kmsg'; msg.innerHTML = html; d.appendChild(msg);
  const row = document.createElement('div'); row.className = 'kacts';
  for(const [label, fn, cls] of buttons.list){
    const b = document.createElement('button'); b.innerHTML = label; if(cls) b.className = cls;
    b.onclick = () => { unlockAudio(); fn(b); }; row.appendChild(b);
  }
  d.appendChild(row); return d;
}
const againBtns = () => [['🔁 Cook again', () => refill(lastCook.els)], ['Pour out', emptyPot], ['✕', () => leaveKitchen()]];

// Step 1: the brew is done. Show real bond orders, then offer to salt it with hydrogens.
function saltPhase(r){
  const copies = r.products.flatMap(p => p.copies);
  // the pot as cooked, with the bond orders the server read from the bond lengths
  bonds = [];
  for(const c of copies) for(const [a, b, o] of c.bonds) if(a < c.idx.length && b < c.idx.length) bonds.push({a:c.idx[a], b:c.idx[b], o});
  rebuild();
  const free = copies.reduce((s, c) => s + c.atoms.length - c.idx.length, 0);
  const pot = escapeHTML(r.pot);
  if(!r.products.length){
    $('info').textContent = '🧙 Nothing bonded this time';
    donePanel(`The brew: <b>${pot}</b>. Nothing bonded this time: try more atoms, a higher temperature or a longer cook.`, {phase:'salt', list:againBtns()});
    return;
  }
  $('info').textContent = `✨ The brew is done: ${r.pot}`;
  if(!free) return servePhase(r);
  donePanel(`✨ The brew is done: <b>${pot}</b>${r.first_bond_fs ? ` · first bond after ${r.first_bond_fs} fs` : ''}.<br>
    There ${free === 1 ? 'is 1 free bond' : `are ${free} free bonds`}. Sprinkle hydrogens on ${free === 1 ? 'it' : 'them'}?`,
    {phase:'salt', list:[['🧂 Sprinkle hydrogens', () => sprinkle(r), 'kgo'], ...againBtns()]});
}

// Step 2: a salt-shaker flourish from up high; each H falls onto its free bond with a tink.
function sprinkle(r){
  const copies = r.products.flatMap(p => p.copies);
  phase = kitchen.dataset.phase = 'salting'; $('kdone').querySelectorAll('button').forEach(b => b.disabled = true);
  const top = new THREE.Vector3(0, POT_S * 1.55, 0), t0 = performance.now() + 450;
  const sh = $('shaker'), v = top.clone().add(world.position).project(camera), rc = canvas.getBoundingClientRect();
  sh.style.left = `${rc.left + (v.x + 1) / 2 * rc.width}px`; sh.style.top = `${Math.max(150, rc.top + (1 - v.y) / 2 * rc.height)}px`;
  sh.classList.remove('hidden', 'go'); void sh.offsetWidth; sh.classList.add('go');
  CSFX.shake();
  let k = 0, landed = 0;
  const jobs = [];
  for(const c of copies){
    const map = c.idx.slice();
    for(let l = c.idx.length; l < c.atoms.length; l++){
      const a = c.atoms[l], to = new THREE.Vector3(a.x, a.y, a.z), parent = c.bonds.find(b => b[0] === l || b[1] === l);
      const heavy = parent ? map[parent[0] === l ? parent[1] : parent[0]] : null;
      const from = top.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.8, Math.random() * 0.5, (Math.random() - 0.5) * 0.8));
      const i = atoms.length; map.push(i); const kk = k++;
      atoms.push({el:'H', p:from.clone(), born:t0 + 85 * kk, drop:{from, to, t0:t0 + 85 * kk, ms:520, onLand: () => {
        if(heavy !== null) bonds.push({a:heavy, b:i, o:1});
        burst(to.clone(), [0xffffff, 0xfff7d6], 8, 1.4, 0.35, 0.1, 2); CSFX.salt(kk);
        if(++landed === k) setTimeout(() => servePhase(r), 450);
      }}});
      jobs.push(kk);
    }
  }
  // salt grains trickling from the shaker while the hydrogens fall
  const grains = setInterval(() => burst(top.clone(), [0xffffff, 0xf3f0e6], 6, 0.6, 0.9, 0.08, 7), 70);
  setTimeout(() => clearInterval(grains), 450 + 85 * k + 300);
  sh.style.animationDuration = `${(450 + 85 * k + 700) / 1000}s`;
  setTimeout(() => sh.classList.add('hidden'), 450 + 85 * k + 700);
  rebuild();
}

// Step 3: what's in the pot, ready to add. Atoms that didn't make a molecule puff away.
let addingMols = false;
function servePhase(r){
  const copies = r.products.flatMap(p => p.copies);
  const keep = new Set(copies.flatMap(c => c.idx));
  const heavyN = r.symbols.length;
  atoms.forEach((a, i) => { if(i < heavyN && !keep.has(i)) burst(a.p.clone(), [0x9dffd0, 0xffffff], 10, 1.5, 0.5, 0.12, -1); });
  // rebuild the pot from the saturated pieces, in place
  const na = [], nb = [];
  for(const c of copies){
    const off = na.length;
    c.atoms.forEach(a => na.push({el:a.el, p:new THREE.Vector3(a.x, a.y, a.z)}));
    c.bonds.forEach(([a, b, o]) => nb.push({a:off + a, b:off + b, o}));
  }
  atoms = na; bonds = nb; rebuild();
  const n = r.products.length;
  const d = donePanel(`${n > 1 ? `${n} molecules` : 'A molecule'} in the pot. Add ${n > 1 ? 'them' : 'it'} to your collection?<br><small class="khint">Drag to turn the pot around, pinch or scroll to zoom.</small>`,
    {phase:'serve', list:[[`⭐ Add ${n > 1 ? `${n} molecules` : 'it'}`, b => addMolecules(r, b), 'kgo'], ...againBtns()]});
  const list = document.createElement('div'); list.className = 'kmols';
  r.products.forEach((p, i) => {
    const row = document.createElement('label'); row.className = 'kmol';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = true; cb.dataset.i = i;
    cb.onchange = () => { SFX.tick(); const k = list.querySelectorAll('input:checked').length; const go = d.querySelector('.kgo'); if(go && !go.dataset.done){ go.disabled = !k; go.innerHTML = `⭐ Add ${k === 1 ? 'it' : `${k} molecules`}`; } };
    const f = document.createElement('b'); formulaInto(f, p.formula);
    const s = document.createElement('small'); s.textContent = `${p.smiles || ''}${p.copies.length > 1 ? ` · ×${p.copies.length} in the pot` : ''}`;
    const res = document.createElement('span'); res.className = 'kres';
    const edit = document.createElement('button'); edit.className = 'link ico';
    edit.innerHTML = `${$('submit').querySelector('svg').outerHTML}<span>Build</span>`;  // the builder's flask
    edit.title = 'Open it in the builder to change it and Build it there';
    edit.onclick = e => { e.preventDefault(); useCookProduct(p); };
    row.append(cb, f, s, res, edit); list.appendChild(row);
  });
  d.insertBefore(list, d.lastChild);
  $('info').textContent = `🍽️ Served: ${r.products.map(p => p.formula).join(' + ')}`;
  SFX.chime();
}

async function addMolecules(r, btn){
  const picks = [...kitchen.querySelectorAll('.kmol input')].filter(c => c.checked).map(c => +c.dataset.i);
  if(!picks.length || addingMols) return;
  addingMols = true; btn.disabled = true; btn.dataset.done = '1';
  kitchen.querySelectorAll('.kmol input, .kmol .link, #kdone .kacts button').forEach(b => b.disabled = true);
  let got = 0;
  for(const i of picks){
    const p = r.products[i], res = kitchen.querySelectorAll('.kmol .kres')[i];
    res.textContent = '…'; res.className = 'kres busy';
    try{
      const j = await api('/api/submissions', {method:'POST', body:{atoms:p.atoms, bonds:p.bonds, input_method:'cook', mode:'stable'}});
      total = j.total; LS.set('qm.total', total); $('total').textContent = `${total.toLocaleString()} ⭐`;
      res.textContent = j.score > 0 ? `+${j.score.toLocaleString()}` : '+0'; res.className = 'kres ' + (j.score > 0 ? 'ok' : 'zero');
      res.title = (j.pubchem && j.pubchem.name) || j.warning || '';
      got += j.score;
      if(j.score > 0){ SFX.chime(); burst(new THREE.Vector3(0, POT_S * 0.6, 0), [0xffd166, 0x7c5cff, 0x20d3a7], 24, 3, 0.7, 0.2); }
    }catch(e){
      res.textContent = '✕'; res.className = 'kres zero'; res.title = e.message || 'Failed';
      if(e.status === 401){ addingMols = false; leaveKitchen(); setAccount(null, null); showWelcome(); return; }
    }
  }
  addingMols = false; checkBadges();
  if(got > 0){ SFX.fanfare(); toast(`+${got.toLocaleString()} ⭐ from the cauldron`, 3000); } else toast('No new points this time');
  const d = $('kdone');
  d.querySelector('.kmsg').textContent = got > 0 ? `Added! +${got.toLocaleString()} ⭐` : 'Added, but no new points this time (already in your collection, or not stable).';
  d.querySelectorAll('.kacts button, .kmol .link').forEach(b => { if(!b.classList.contains('kgo')) b.disabled = false; });
  btn.remove();
}

// Leave the kitchen: back to the player's own molecule (restore) or keep what's on screen.
function leaveKitchen(restoreWork = true){
  if(!cooking || addingMols) return;
  cooking = false; simmering = false; busy = false; pot.visible = false; ambience.stop(); phase = 'prep';
  document.body.classList.remove('busy', 'cooking', 'simmer');
  kitchen.classList.add('hidden'); $('optInfo').classList.add('hidden'); $('shaker').classList.add('hidden');
  scene.background = new THREE.Color(0x0b1020); scene.getObjectByName('stars').visible = true;
  setXYZOpen(cookXYZ, false);
  controls.enableDamping = false; controls.update(); controls.enableDamping = true;
  if(cookCam){ camera.position.copy(cookCam.p); controls.target.copy(cookCam.t); cookCam = null; }
  potOrbitOff();
  controls.enabled = true;
  atoms = []; bonds = [];
  if(restoreWork && cookSaved) restore(cookSaved);
  cookSaved = null; changed();
}

function useCookProduct(prod){
  const saved = cookSaved;
  leaveKitchen(false);
  atoms = prod.atoms.map(a => ({el:a.el, p:new THREE.Vector3(a.x, a.y, a.z), born:performance.now()}));
  bonds = prod.bonds.map(([a, b, o]) => ({a, b, o}));
  inputMethod = 'cook';
  if(saved){ undoStack.push(saved); if(undoStack.length > 60) undoStack.shift(); }  // Undo brings back the old molecule
  changed(); SFX.chime();
  toast(`${prod.formula} is in the builder: press Build to score it`, 3200);
}

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
  updateBursts(dt); updatePot(dt, now);
  if(atoms.some(a => a.born && now - a.born < 360)) rebuild();
  if(shake > 0.001){ world.position.set((Math.random()-0.5)*shake, (Math.random()-0.5)*shake, 0); shake *= 0.9; }
  else world.position.set(0,0,0);
  if(cooking) controls.target.lerp(POT_VIEW, 0.1);  // the cauldron stays in the middle
  else if(atoms.length && dragging === null) controls.target.lerp(centroid(), 0.06);
  scene.getObjectByName('stars').rotation.y += dt*0.01;
  controls.update();
  renderer.render(scene, camera);
  updateMeasures();
}

/* ================= start ================= */
// ?debug exposes a few internals to the console and the browser tests.
if(new URLSearchParams(location.search).has('debug')) window.qm = {get camera(){ return camera; }, get controls(){ return controls; }, get atoms(){ return atoms; }, get bubbles(){ return bubbles; }, get canvas(){ return canvas; }};
{
  let w = null; try{ w = localStorage.getItem('qm.work'); }catch{}
  if(w) restore(w);
  rebuild(); updateInfo(); setXYZOpen(xyzOpen);
  requestAnimationFrame(loop);
  detectServer().then(async () => {
    $('lb').classList.toggle('hidden', !ONLINE);
    $('puzzleBtn').classList.toggle('hidden', !ONLINE);
    $('cookBtn').classList.toggle('hidden', !(ONLINE && SERVER.cook));
    if(!ONLINE) loadRDKit(); else updateInfo();
    if(ONLINE && !token) return showWelcome();
    if(ONLINE){
      try{ const me = await api('/api/me'); total = me.total; nick = me.nickname; LS.set('qm.total', total); updateInfo(); checkBadges(); }
      catch(e){ if(e.status === 401){ setAccount(null, null); return showWelcome(); } }
    } else toast('Offline mode: scores stay on this device', 2500);
    if(!LS.get('qm.seenHelp', false)){ LS.set('qm.seenHelp', true); showIntro(); }
  });
}
