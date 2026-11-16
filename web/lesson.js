// Beginner lesson: what atoms are, electrons and shells, valence electrons, the full
// shell (octet), and how sharing electrons makes bonds, with lone pairs and a double
// bond. A 2D stage (SVG) where the player drags atoms together and watches the electron
// pairs form. No chemistry knowledge assumed.
const NS = 'http://www.w3.org/2000/svg';
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];  // the four sides of an atom: up, right, down, left
const ACOL = {H:'#f4f6ff', C:'#8d96a3', N:'#3d6bff', O:'#ff3b3b', F:'#7ee06a'};
const ECOL = {H:'#7fd3ff', C:'#ffd166', N:'#b3c2ff', O:'#ffb0b0', F:'#c4f7a8'};  // electrons keep their atom's tint
const NAME = {H:'Hydrogen', C:'Carbon', N:'Nitrogen', O:'Oxygen', F:'Fluorine'};
const VE = {H:1, C:4, N:5, O:6, F:7};
const Z = {H:1, C:6, N:7, O:8, F:9};
const LAYOUT = {H:[1, 0, 0, 0], C:[1, 1, 1, 1], N:[2, 1, 1, 1], O:[2, 1, 1, 2], F:[2, 2, 1, 2]};
const RAD = el => el === 'H' ? 15 : 21;
const ER = el => RAD(el) + 12;              // where the outer electrons sit
const FULL = el => el === 'H' ? 2 : 8;
const BLEN = (a, b) => RAD(a) + RAD(b) + 48;  // long enough that the bond line shows on both sides of the shared pair

function svg(tag, attrs = {}, parent = null){
  const e = document.createElementNS(NS, tag);
  for(const k in attrs) e.setAttribute(k, attrs[k]);
  if(parent) parent.appendChild(e);
  return e;
}
function shade(hex, k){  // k > 0 lightens toward white, k < 0 darkens
  const n = parseInt(hex.slice(1), 16), c = [n >> 16, (n >> 8) & 255, n & 255];
  return '#' + c.map(v => Math.round(k > 0 ? v + (255 - v) * k : v * (1 + k)).toString(16).padStart(2, '0')).join('');
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ================= the stage: atoms, electrons and bonds ================= */
class Stage {
  constructor(root, sfx){
    this.root = root; this.sfx = sfx;
    root.addEventListener('pointerdown', e => this.down(e));
    root.addEventListener('pointermove', e => this.move(e));
    root.addEventListener('pointerup', e => this.up(e));
    root.addEventListener('pointercancel', e => this.up(e));
    this.reset();
  }
  reset(){
    const r = this.root; r.innerHTML = '';
    const defs = svg('defs', {}, r);
    for(const el in ACOL){
      const g = svg('radialGradient', {id:`lg-${el}`, cx:'38%', cy:'32%', r:'70%'}, defs);
      svg('stop', {offset:'0%', 'stop-color':shade(ACOL[el], 0.55)}, g);
      svg('stop', {offset:'55%', 'stop-color':ACOL[el]}, g);
      svg('stop', {offset:'100%', 'stop-color':shade(ACOL[el], -0.45)}, g);
    }
    this.gBack = svg('g', {}, r); this.gBonds = svg('g', {}, r); this.gDeco = svg('g', {}, r);
    this.gAtoms = svg('g', {}, r); this.gEls = svg('g', {}, r); this.gTop = svg('g', {}, r);
    this.atoms = []; this.bonds = []; this.els = new Map(); this.nextE = 0;
    this.seats = false; this.lonePairs = false; this.lpLabels = true; this.gauges = false;
    this.onBond = this.onTapAtom = this.onTapBond = this.onTap = this.onMsg = null;
    this.dragging = null;
  }
  addAtom(el, x, y, {drag = false, layout = LAYOUT[el], label = null} = {}){
    const a = {i:this.atoms.length, el, x, y, home:[x, y], goal:null, drag, sides:[[], [], [], []], bonds:[null, null, null, null], wasFull:false};
    layout.forEach((n, s) => { for(let k = 0; k < n; k++){ const id = this.nextE++; this.els.set(id, {id, owner:a, x, y, node:null}); a.sides[s].push(id); } });
    const g = a.g = svg('g', {class:'la' + (drag ? ' drag' : ''), 'data-i':a.i}, this.gAtoms);
    svg('circle', {r:RAD(el) + 16, fill:'transparent'}, g);  // a bigger target for fingers
    a.gaugeBg = svg('circle', {r:RAD(el) + 5, class:'lgauge-bg'}, g);
    a.gauge = svg('circle', {r:RAD(el) + 5, class:'lgauge', transform:'rotate(-90)'}, g);
    svg('circle', {r:RAD(el), fill:`url(#lg-${el})`, stroke:shade(ACOL[el], -0.55), 'stroke-width':1}, g);
    const t = svg('text', {class:'lsym', y:el === 'H' ? 5 : 6, fill:el === 'H' || el === 'F' ? '#1b2238' : '#fff'}, g); t.textContent = el;
    if(label){ const l = svg('text', {class:'lname', y:RAD(el) + 30}, g); l.textContent = label; }
    for(const list of a.sides) for(const id of list){
      const e = this.els.get(id);
      e.node = svg('circle', {r:4.4, class:'lel', fill:ECOL[el]}, this.gEls);
    }
    this.atoms.push(a);
    this.snapElectrons();
    return a;
  }
  count(a){  // electrons the atom counts as its own: its dots plus every electron in its bonds
    let n = 0;
    a.sides.forEach((l, s) => { n += a.bonds[s] ? a.bonds[s].els.length : l.length; });
    return n;
  }
  full(a){ return this.count(a) >= FULL(a.el); }
  singles(a){ return [0, 1, 2, 3].filter(s => !a.bonds[s] && a.sides[s].length === 1); }
  nBonds(a){ return a.bonds.filter(Boolean).length; }

  targets(){
    const T = new Map();
    for(const a of this.atoms){
      a.sides.forEach((list, s) => {
        if(a.bonds[s]) return;
        const [dx, dy] = DIRS[s], r = ER(a.el), bx = a.x + dx * r, by = a.y + dy * r;
        list.forEach((id, k) => {
          const off = list.length === 2 || this.seats ? (k ? 5 : -5) : 0;
          T.set(id, [bx - dy * off, by + dx * off]);
        });
      });
    }
    for(const b of this.bonds){
      const {a:A, b:B} = b, mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
      let ux = B.x - A.x, uy = B.y - A.y; const l = Math.hypot(ux, uy) || 1; ux /= l; uy /= l;
      const np = b.els.length / 2;
      b.els.forEach((id, k) => {
        const along = (Math.floor(k / 2) - (np - 1) / 2) * 11, off = k % 2 ? 5 : -5;
        T.set(id, [mx + ux * along - uy * off, my + uy * along + ux * off]);
      });
    }
    return T;
  }
  snapElectrons(){ for(const [id, [x, y]] of this.targets()){ const e = this.els.get(id); e.x = x; e.y = y; } }

  // Bond atom d (just dropped) to atom t, on the side of t that faces d.
  tryBond(d, t){
    const vx = d.x - t.x, vy = d.y - t.y;
    const ts = [0, 1, 2, 3].reduce((best, s) => DIRS[s][0] * vx + DIRS[s][1] * vy > DIRS[best][0] * vx + DIRS[best][1] * vy ? s : best, 0);
    const fs = (ts + 2) % 4;
    if(this.full(t)) return ['full', t];
    if(this.full(d)) return ['full', d];
    if(t.bonds[ts]) return ['taken', t];
    if(VE[t.el] === 1 && !this.nBonds(t)) this.turn(t, ts);  // a lone H turns its electron to face the partner
    if(t.sides[ts].length === 2) return ['pair', t];
    if(!t.sides[ts].length) return ['nothing', t];
    if(!this.nBonds(d)){ if(!this.turn(d, fs)) return ['pair', d]; }  // a free atom turns a single electron toward t
    else if(d.bonds[fs] || d.sides[fs].length !== 1) return ['pair', d];
    const goal = [t.x + DIRS[ts][0] * BLEN(t.el, d.el), t.y + DIRS[ts][1] * BLEN(t.el, d.el)];
    if(this.atoms.some(o => o !== d && o !== t && Math.hypot(o.x - goal[0], o.y - goal[1]) < 30)) return ['crowded', t];
    const b = {a:t, sa:ts, b:d, sb:fs, els:[t.sides[ts].pop(), d.sides[fs].pop()], t0:performance.now()};
    t.bonds[ts] = b; d.bonds[fs] = b;
    this.bonds.push(b);
    d.goal = goal; d.drag = false; d.g.classList.remove('drag');
    this.buildBond(b);
    this.sfx.bond(1);
    setTimeout(() => this.sparkle((t.x + goal[0]) / 2, (t.y + goal[1]) / 2, '#ffd166'), 260);
    return ['ok', b];
  }
  // Rotate an unbonded atom's electrons so that side s holds a single electron.
  turn(a, s){
    const k = [0, 1, 2, 3].find(k => a.sides[(s - k + 4) % 4].length === 1);
    if(k === undefined) return false;
    a.sides = a.sides.map((_, i) => a.sides[(i - k + 4) % 4]);
    return true;
  }
  // Share one more pair in bond b (single → double → triple), from each atom's single electrons.
  promote(b){
    const sa = this.singles(b.a).find(s => s !== b.sa), sb = this.singles(b.b).find(s => s !== b.sb);
    if(sa === undefined || sb === undefined) return false;
    b.els.push(b.a.sides[sa].pop(), b.b.sides[sb].pop());
    b.t0 = performance.now(); this.buildBond(b);
    this.sfx.bond(b.els.length / 2);
    setTimeout(() => this.sparkle((b.a.x + b.b.x) / 2, (b.a.y + b.b.y) / 2, '#20d3a7'), 260);
    return true;
  }
  buildBond(b){
    if(b.g) b.g.remove();
    b.g = svg('g', {class:'lbond', 'data-i':this.bonds.indexOf(b)}, this.gBonds);
    b.hit = svg('line', {class:'lbond-hit'}, b.g);
    b.lines = Array.from({length:b.els.length / 2}, () => svg('line', {class:'lbond-line'}, b.g));
  }
  sparkle(x, y, color){
    for(let k = 0; k < 3; k++){
      const c = svg('circle', {cx:x, cy:y, r:6 + k * 5, class:'lspark', stroke:color, style:`animation-delay:${k * 90}ms`}, this.gTop);
      setTimeout(() => c.remove(), 900 + k * 90);
    }
  }
  say(text, x, y, cls = ''){  // a floating note on the stage
    const t = svg('text', {x, y, class:'lnote ' + cls}, this.gTop); t.textContent = text;
    setTimeout(() => t.remove(), 1800);
  }

  tick(now){
    for(const a of this.atoms){
      if(a.goal){ a.x += (a.goal[0] - a.x) * 0.22; a.y += (a.goal[1] - a.y) * 0.22; if(Math.hypot(a.goal[0] - a.x, a.goal[1] - a.y) < 0.2){ [a.x, a.y] = a.goal; a.goal = null; } }
      a.g.setAttribute('transform', `translate(${a.x.toFixed(2)} ${a.y.toFixed(2)})`);
      const C = 2 * Math.PI * (RAD(a.el) + 5), f = Math.min(1, this.count(a) / FULL(a.el)), full = f >= 1;
      a.gauge.style.display = a.gaugeBg.style.display = this.gauges ? '' : 'none';
      a.gauge.setAttribute('stroke-dasharray', `${(C * f).toFixed(1)} ${C.toFixed(1)}`);
      a.gauge.classList.toggle('full', full);
      if(this.gauges && full && !a.wasFull){ a.wasFull = true; setTimeout(() => { this.sparkle(a.x, a.y, '#20d3a7'); this.say('full ✓', a.x - RAD(a.el) - 6, a.y - RAD(a.el) - 6, 'ok end'); }, 380); }
    }
    const T = this.targets();
    for(const [id, [x, y]] of T){
      const e = this.els.get(id); e.x += (x - e.x) * 0.16; e.y += (y - e.y) * 0.16;
      e.node.setAttribute('cx', e.x.toFixed(2)); e.node.setAttribute('cy', e.y.toFixed(2));
    }
    for(const b of this.bonds){
      const {a:A, b:B} = b; let ux = B.x - A.x, uy = B.y - A.y; const l = Math.hypot(ux, uy) || 1; ux /= l; uy /= l;
      const x1 = A.x + ux * (RAD(A.el) + 3), y1 = A.y + uy * (RAD(A.el) + 3), x2 = B.x - ux * (RAD(B.el) + 3), y2 = B.y - uy * (RAD(B.el) + 3);
      for(const n of [b.hit]) Object.entries({x1, y1, x2, y2}).forEach(([k, v]) => n.setAttribute(k, v.toFixed(2)));
      const op = Math.max(0, Math.min(1, (now - b.t0 - 350) / 450)), n = b.lines.length;
      b.lines.forEach((ln, j) => {
        const off = (j - (n - 1) / 2) * 7;
        ln.setAttribute('x1', (x1 - uy * off).toFixed(2)); ln.setAttribute('y1', (y1 + ux * off).toFixed(2));
        ln.setAttribute('x2', (x2 - uy * off).toFixed(2)); ln.setAttribute('y2', (y2 + ux * off).toFixed(2));
        ln.style.opacity = j === n - 1 ? op : 1;
      });
    }
    if(this.seats || this.lonePairs) this.drawDeco();
  }
  drawDeco(){
    this.gDeco.innerHTML = '';
    for(const a of this.atoms){
      a.sides.forEach((list, s) => {
        if(a.bonds[s] || a.goal) return;
        const [dx, dy] = DIRS[s], r = ER(a.el), bx = a.x + dx * r, by = a.y + dy * r;
        if(this.seats && (a.el !== 'H' || s === 0)){
          for(let k = list.length; k < 2; k++){
            const off = k ? 5 : -5;
            svg('circle', {cx:bx - dy * off, cy:by + dx * off, r:4.4, class:'lseat'}, this.gDeco);
          }
        }
        if(this.lonePairs && a.el !== 'H' && list.length === 2){
          svg('ellipse', {cx:bx, cy:by, rx:dx ? 7 : 12, ry:dx ? 12 : 7, class:'llp'}, this.gDeco);
          if(this.lpLabels){
            const t = svg('text', {x:bx + dx * 14, y:by + dy * 18 + 3, class:'llp-t', 'text-anchor':dx > 0 ? 'start' : dx < 0 ? 'end' : 'middle'}, this.gDeco);
            t.textContent = 'lone pair';
          }
        }
      });
    }
  }

  pt(e){ const p = this.root.createSVGPoint(); p.x = e.clientX; p.y = e.clientY; return p.matrixTransform(this.root.getScreenCTM().inverse()); }
  down(e){
    const p = this.pt(e);
    if(this.onTap && this.onTap(p, e)) return;
    if(this.onTapBond){  // by geometry: the electron dots and the atoms' finger targets sit on top of the bond
      const b = this.bonds.find(({a:A, b:B}) => {
        const ux = B.x - A.x, uy = B.y - A.y, k = Math.max(0, Math.min(1, ((p.x - A.x) * ux + (p.y - A.y) * uy) / (ux * ux + uy * uy)));
        return Math.hypot(p.x - A.x - k * ux, p.y - A.y - k * uy) < 16 && Math.hypot(p.x - A.x, p.y - A.y) > RAD(A.el) + 2 && Math.hypot(p.x - B.x, p.y - B.y) > RAD(B.el) + 2;
      });
      if(b){ this.onTapBond(b); return; }
    }
    const g = e.target.closest('.la'); if(!g) return;
    const a = this.atoms[+g.dataset.i];
    if(this.onTapAtom) this.onTapAtom(a);
    if(!a.drag) return;
    this.dragging = {a, dx:a.x - p.x, dy:a.y - p.y}; a.goal = null;
    g.classList.add('held'); this.gAtoms.appendChild(g);
    try{ this.root.setPointerCapture(e.pointerId); }catch{}
    this.sfx.pop(a.el);
  }
  move(e){
    if(!this.dragging) return;
    const p = this.pt(e), {a, dx, dy} = this.dragging;
    a.x = Math.max(18, Math.min(382, p.x + dx)); a.y = Math.max(18, Math.min(282, p.y + dy));
  }
  up(){
    if(!this.dragging) return;
    const {a} = this.dragging; this.dragging = null; a.g.classList.remove('held');
    this.drop(a);
  }
  drop(a){
    const near = this.atoms.filter(t => t !== a && Math.hypot(t.x - a.x, t.y - a.y) < BLEN(t.el, a.el) * 1.5)
      .sort((p, q) => Math.hypot(p.x - a.x, p.y - a.y) - Math.hypot(q.x - a.x, q.y - a.y));
    if(!near.length) return;
    const [res, who] = this.tryBond(a, near[0]);
    if(res === 'ok'){ if(this.onBond) this.onBond(who); return; }
    this.sfx.err(); a.goal = a.home.slice();
    if(this.onMsg) this.onMsg(res, who, a);
  }
}

/* ================= the shell picture of an atom (steps 2 and 3) ================= */
function shellAtom(parent, el, x, y, s = 1){
  const g = svg('g', {transform:`translate(${x} ${y}) scale(${s})`, class:'shell'}, parent);
  const z = Z[el], r1 = 26, r2 = 44;
  const rings = el === 'H' ? [[r1, 1, true]] : [[r1, 2, false], [r2, z - 2, true]];
  for(const [r] of rings) svg('circle', {r, class:'orbit'}, g);
  const nuc = svg('g', {class:'nuc'}, g);
  const nn = el === 'H' ? 1 : 2 * z;
  for(let i = nn - 1; i >= 0; i--){
    const rr = 2.6 * Math.sqrt(i), th = i * 2.4;
    svg('circle', {cx:rr * Math.cos(th), cy:rr * Math.sin(th), r:3.1, class:i % 2 === 0 ? 'proton' : 'neutron'}, nuc);
  }
  rings.forEach(([r, n, outer], k) => {
    const spin = svg('g', {class:'spin ' + (outer ? 'eout' : 'ein'), style:`animation-duration:${outer ? 9 : 5}s${k % 2 ? ';animation-direction:reverse' : ''}`}, g);
    for(let j = 0; j < n; j++){ const th = 2 * Math.PI * j / n; svg('circle', {cx:r * Math.cos(th), cy:r * Math.sin(th), r:3.8, class:'lel'}, spin); }
  });
  return g;
}
// A 3D ball-and-stick molecule for the welcome step: real geometry (Å), gently rocking.
const SQ = Math.sqrt;
const MOLS = {
  water:  {atoms:[['O', 0, 0.293, 0], ['H', 0.759, -0.293, 0], ['H', -0.759, -0.293, 0]], bonds:[[0, 1, 1], [0, 2, 1]]},  // O–H 0.96 Å, 104.5°
  oxygen: {atoms:[['O', 0.605, 0, 0], ['O', -0.605, 0, 0]], bonds:[[0, 1, 2]]},  // O=O 1.21 Å
  methane:{atoms:[['C', 0, 0, 0], ['H', 0, 1.09, 0], ...[90, 210, 330].map(d => ['H', 1.09 * SQ(8) / 3 * Math.cos(d * Math.PI / 180), -1.09 / 3, 1.09 * SQ(8) / 3 * Math.sin(d * Math.PI / 180)])],
           bonds:[[0, 1, 1], [0, 2, 1], [0, 3, 1], [0, 4, 1]]},  // tetrahedral, C–H 1.09 Å, 109.5°
};
const BALL = {H:8, C:12, O:12};
function drawMol(g, mol, cx, cy, yaw, pitch = 0.2, s = 44){
  g.replaceChildren();
  const cy_ = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const P = mol.atoms.map(([el, x, y, z]) => {
    const x1 = x * cy_ + z * sy, z1 = -x * sy + z * cy_;  // turn around the vertical axis
    const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;   // tip toward the viewer
    const f = 9 / (9 - z2);
    return {el, X:cx + x1 * s * f, Y:cy - y2 * s * f, z:z2, f};
  });
  const items = [];
  for(const [i, j, o] of mol.bonds) items.push({z:(P[i].z + P[j].z) / 2 - 0.01, draw(){
    const a = P[i], b = P[j], l = Math.hypot(b.X - a.X, b.Y - a.Y) || 1, w = 4.5 * (a.f + b.f) / 2;
    const offs = o === 2 ? [-3.6, 3.6] : [0];
    // run the stick from ball edge to ball edge, so it never covers an atom's letter
    const ux = (b.X - a.X) / l, uy = (b.Y - a.Y) / l, ra = BALL[a.el] * a.f * 0.8, rb = BALL[b.el] * b.f * 0.8;
    if(l <= ra + rb) return;
    for(const off of offs){
      const px = -uy * off, py = ux * off;
      svg('line', {x1:a.X + ux * ra + px, y1:a.Y + uy * ra + py, x2:b.X - ux * rb + px, y2:b.Y - uy * rb + py, class:'lstick', style:`stroke-width:${(o === 2 ? w * 0.75 : w).toFixed(2)}`}, g);
    }
  }});
  for(const a of P) items.push({z:a.z, draw(){
    const r = BALL[a.el] * a.f;
    svg('circle', {cx:a.X, cy:a.Y, r, fill:`url(#lg-${a.el})`, stroke:shade(ACOL[a.el], -0.55), 'stroke-width':0.8}, g);
    const t = svg('text', {x:a.X, y:a.Y + r * 0.36, class:'lballsym', style:`font-size:${(r * 1.0).toFixed(1)}px;fill:${a.el === 'H' ? '#2a3150' : '#fff'}`}, g);
    t.textContent = a.el;
  }});
  items.sort((p, q) => p.z - q.z).forEach(it => it.draw());
}

/* ================= the steps ================= */
// Each step builds its scene with setup(ctx); it calls ctx.done() when the player has done
// the task. demo(ctx) does the task for them (the "Show me" button).
async function demoBond(st, ctx){
  for(const d of st.atoms.filter(a => a.drag)){
    for(const t of st.atoms){
      if(t === d || st.full(t)) continue;
      for(const s of st.singles(t)){
        const L = BLEN(t.el, d.el), gx = t.x + DIRS[s][0] * L, gy = t.y + DIRS[s][1] * L;
        if(gx < 20 || gx > 380 || gy < 20 || gy > 280) continue;
        if(st.atoms.some(o => o !== d && o !== t && Math.hypot(o.x - gx, o.y - gy) < 30)) continue;
        d.goal = [t.x + DIRS[s][0] * L * 1.05, t.y + DIRS[s][1] * L * 1.05];
        st.sfx.pop(d.el);
        await sleep(650);
        if(!ctx.alive()) return false;
        st.drop(d);
        return true;
      }
    }
  }
  return false;
}
const tapAll = async (ctx, items, fn) => { for(const it of items){ if(!ctx.alive()) return; fn(it); await sleep(550); } };

const STEPS = [
  {
    title:'Everything is made of atoms',
    text:`Water, air, your phone, even you: everything is built from tiny pieces called <b>atoms</b>. They're far too small to see. One drop of water holds about 5,000,000,000,000,000,000,000 of them!
      <br><br>Atoms join together into <b>molecules</b>. In this short lesson you'll find out <b>why</b> atoms stick together, and why each kind of atom always makes the same number of connections.`,
    task:'Tap a molecule to give it a wiggle, then press Next.',
    setup(ctx){
      const st = ctx.stage, g = st.gBack;
      const mols = [
        ['water', 'water, H₂O', ['1 oxygen (O)', '2 hydrogen (H)'], 'O'],
        ['oxygen', 'oxygen gas, O₂', ['2 oxygen (O)'], 'O'],
        ['methane', 'natural gas, CH₄', ['1 carbon (C)', '4 hydrogen (H)'], 'C'],
      ];
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const draws = mols.map(([key, label, parts, snd], k) => {
        const x = 70 + 130 * k, y = 110;
        const m = svg('g', {class:'lmol', style:`animation-delay:${k * -1.1}s`}, g);
        svg('circle', {cx:x, cy:y, r:52, fill:'transparent'}, m);  // a generous tap target
        const inner = svg('g', {}, m);
        const t = svg('text', {x, y:188, class:'lname'}, g); t.textContent = label;
        parts.forEach((p, i) => { const e = svg('text', {x, y:204 + 13 * i, class:'lhint'}, g); e.textContent = p; });
        m.addEventListener('pointerdown', () => { m.classList.remove('wig'); void m.getBBox(); m.classList.add('wig'); st.sfx.pop(snd); ctx.done(); });
        return t => drawMol(inner, MOLS[key], x, y, 0.5 * Math.sin(t / 1500 + k * 2.1));
      });
      const spin = now => { if(!ctx.alive() || !g.isConnected) return; draws.forEach(d => d(still ? 0 : now)); if(!still) requestAnimationFrame(spin); };
      spin(performance.now());
      // the key, as two rows
      const kb = svg('g', {}, g);
      svg('circle', {cx:154, cy:249, r:6, fill:'url(#lg-C)'}, kb);
      svg('line', {x1:146, y1:269, x2:162, y2:269, class:'lstick', style:'stroke-width:4.5'}, kb);
      [['balls = atoms', 249], ['sticks = bonds', 269]].forEach(([s_, yy]) => { const e = svg('text', {x:172, y:yy + 4, class:'lkey'}, kb); e.textContent = s_; });
    },
    demo(ctx){ ctx.done(); },
  },
  {
    title:'Inside an atom',
    text:`Let's zoom into a <b>carbon</b> atom. In the middle sits a tiny, heavy <b>nucleus</b> made of <b>protons</b> (they carry a + charge) and <b>neutrons</b> (no charge).
      Around it zip much lighter <b>electrons</b> (− charge). Plus and minus attract, so the electrons stay close to the nucleus, moving in layers called <b>shells</b>.`,
    task:'Tap the nucleus, then tap an electron.',
    after:'The first shell has room for <b>2</b> electrons, the next one for <b>8</b>. Carbon has 6 electrons: 2 in the first shell and 4 in the second.',
    setup(ctx){
      const st = ctx.stage, X = 200, Y = 140, S = 2.3;
      shellAtom(st.gBack, 'C', X, Y, S);
      const seen = new Set();
      const label = (key, text, x1, y1, x2, y2, anchor) => {
        if(seen.has(key)) return; seen.add(key);
        svg('line', {x1, y1, x2, y2, class:'lleader'}, st.gTop);
        const t = svg('text', {x:x2 + (anchor === 'end' ? -4 : anchor === 'start' ? 4 : 0), y:anchor === 'middle' ? y2 - 5 : y2 + 4, class:'llabel', 'text-anchor':anchor}, st.gTop);
        t.textContent = text; st.sfx.tick(seen.size);
        if(seen.size === 2) ctx.done();
      };
      ctx.tapNucleus = () => label('n', 'nucleus: 6 protons + 6 neutrons', X + 4, Y - 8, X + 50, Y - 122, 'middle');
      ctx.tapElectron = () => label('e', 'electrons (−)', X - 90, Y + 40, X - 120, Y + 128, 'end');
      st.onTap = p => {
        const d = Math.hypot(p.x - X, p.y - Y);
        if(d < 16 * S) ctx.tapNucleus(); else if(d < 52 * S) ctx.tapElectron();
        return true;
      };
    },
    async demo(ctx){ ctx.tapNucleus(); await sleep(600); if(ctx.alive()) ctx.tapElectron(); },
  },
  {
    title:'The outer shell is what counts',
    text:`An atom's outermost layer of electrons is its <b>outer shell</b>, and the electrons in it are called <b>valence electrons</b>. When atoms meet, only the valence electrons interact with each other, so they decide how an atom bonds.
      <br><br>The electrons in the inner shells are called <b>core electrons</b>. They stay tucked in close to the nucleus and don't take part in bonding.`,
    task:'Tap each atom to count its valence (outer-shell) electrons.',
    after:'Hydrogen has <b>1</b> valence electron, carbon <b>4</b>, nitrogen <b>5</b> and oxygen <b>6</b>. Carbon, nitrogen and oxygen also have <b>2</b> core electrons each (faded); hydrogen has none.',
    setup(ctx){
      const st = ctx.stage, xs = {H:55, C:150, N:252, O:345}, done = new Set();
      ctx.count = el => {
        if(done.has(el)) return; done.add(el);
        const g = ctx.shells[el]; g.classList.add('count');
        const t = svg('text', {x:xs[el], y:228, class:'lcount'}, st.gTop); t.textContent = `${VE[el]} valence`;
        const cc = svg('text', {x:xs[el], y:243, class:'lhint'}, st.gTop); cc.textContent = el === 'H' ? 'no core' : `${Z[el] - VE[el]} core`;
        st.sfx.tick(VE[el]);
        if(done.size === 4) ctx.done();
      };
      ctx.shells = {};
      for(const el in xs){
        const g = ctx.shells[el] = shellAtom(st.gBack, el, xs[el], 130, 0.85);
        svg('circle', {r:52, fill:'transparent'}, g);
        g.style.cursor = 'pointer';
        g.addEventListener('pointerdown', () => ctx.count(el));
        const t = svg('text', {x:xs[el], y:195, class:'lname'}, st.gBack); t.textContent = NAME[el];
      }
    },
    demo(ctx){ return tapAll(ctx, ['H', 'C', 'N', 'O'], ctx.count); },
  },
  {
    title:'Atoms want a full outer shell',
    text:`From now on we'll draw just the valence electrons, as dots around the letter. Here's the big idea: an atom is most stable when its outer shell is <b>full</b>.
      For carbon (C), nitrogen (N) and oxygen (O), full means <b>8 electrons</b> (4 pairs). Chemists call this the <b>octet rule</b>. Tiny hydrogen (H) is full with just <b>2</b>. The dashed circles are empty seats.`,
    task:'Tap each atom to see how many electrons it is missing.',
    after:`Electrons spread out one per side first, and pair up only when they run out of sides. So oxygen has two <b>pairs</b> and two <b>single</b> electrons. The single electrons are the ones looking for a partner.`,
    setup(ctx){
      const st = ctx.stage; st.seats = true; st.gauges = true;
      const xs = {H:55, C:150, N:252, O:345}, done = new Set();
      for(const el in xs) st.addAtom(el, xs[el], 125, {label:NAME[el]});
      ctx.tell = a => {
        if(done.has(a.el)) return; done.add(a.el);
        const miss = FULL(a.el) - VE[a.el];
        const t = svg('text', {x:a.x, y:205, class:'lcount'}, st.gTop); t.textContent = `${miss} more`;
        st.sfx.tick(miss);
        if(done.size === 4) ctx.done();
      };
      st.onTapAtom = ctx.tell;
    },
    demo(ctx){ return tapAll(ctx, ctx.stage.atoms, ctx.tell); },
  },
  {
    title:'Sharing makes a bond',
    text:`Hydrogen has 1 electron but wants 2. Two hydrogen atoms can solve this together: they <b>share</b> their electrons.`,
    task:'Drag one hydrogen onto the other.',
    after:`Both electrons now sit between the atoms, and <b>each</b> hydrogen counts both of them, so both are full! A shared pair of electrons is a <b>chemical bond</b>.
      Chemists draw it as a line: <b>H–H</b>. That's hydrogen gas. (See the colors? One electron came from each atom.)`,
    setup(ctx){
      const st = ctx.stage; st.gauges = true;
      st.addAtom('H', 140, 150);
      st.addAtom('H', 290, 150, {drag:true});
      st.onBond = () => ctx.done();
    },
    demo:(ctx) => demoBond(ctx.stage, ctx),
  },
  {
    title:'Why carbon makes 4 bonds',
    text:`Carbon has 4 single electrons, so it has 4 empty seats. Each hydrogen brings one electron to share. Watch the ring around carbon fill up as you go.`,
    task:'Drag each hydrogen onto one of carbon\'s electrons.',
    progress:ctx => `${ctx.stage.nBonds(ctx.stage.atoms[0])} of 4 bonds`,
    after:`4 shared pairs give carbon 8 electrons: full! That's why carbon makes <b>4 bonds</b>. You've built <b>methane</b>, CH₄, the main part of natural gas.`,
    setup(ctx){
      const st = ctx.stage; st.gauges = true;
      const c = st.addAtom('C', 200, 150);
      for(const [x, y] of [[50, 45], [350, 45], [50, 255], [350, 255]]) st.addAtom('H', x, y, {drag:true});
      st.onBond = () => { ctx.update(); if(st.nBonds(c) === 4) ctx.done(); };
      st.onMsg = ctx.explain;
    },
    async demo(ctx){ while(ctx.alive() && !ctx.isDone() && await demoBond(ctx.stage, ctx)) await sleep(500); },
  },
  {
    title:'Oxygen makes 2 bonds and keeps 2 lone pairs',
    text:`Oxygen has 6 valence electrons: two <b>pairs</b> and two <b>singles</b>. A pair is already settled, so a hydrogen can only bond to a <b>single</b> electron. Try dropping a hydrogen on a pair too, and see what happens!`,
    task:'Fill up oxygen with hydrogens.',
    progress:ctx => `${ctx.stage.nBonds(ctx.stage.atoms[0])} of 2 bonds`,
    after:`Just 2 bonds fill oxygen's shell. The two pairs it keeps are called <b>lone pairs</b>. They don't bond, but they take up room and push the hydrogens into a bent shape. That's <b>water</b>, H₂O!`,
    setup(ctx){
      const st = ctx.stage; st.gauges = true;
      const o = st.addAtom('O', 185, 120);
      for(const [x, y] of [[50, 250], [340, 50], [340, 250]]) st.addAtom('H', x, y, {drag:true});
      st.onBond = () => { ctx.update(); if(st.full(o)){ st.lonePairs = true; ctx.done(); } };
      st.onMsg = ctx.explain;
    },
    async demo(ctx){ while(ctx.alive() && !ctx.isDone() && await demoBond(ctx.stage, ctx)) await sleep(500); },
  },
  {
    title:'Nitrogen makes 3',
    text:`Nitrogen has 5 valence electrons: one pair and three singles. How many hydrogens will it take?`,
    task:'Fill up nitrogen with hydrogens.',
    progress:ctx => `${ctx.stage.nBonds(ctx.stage.atoms[0])} bonds so far`,
    after:`3 bonds and 1 lone pair: <b>ammonia</b>, NH₃. Spot the pattern? <b>bonds = 8 − valence electrons</b>. Carbon: 8 − 4 = 4. Nitrogen: 8 − 5 = 3. Oxygen: 8 − 6 = 2.`,
    setup(ctx){
      const st = ctx.stage; st.gauges = true;
      const n = st.addAtom('N', 200, 120);
      for(const [x, y] of [[45, 60], [355, 60], [45, 250], [355, 250]]) st.addAtom('H', x, y, {drag:true});
      st.onBond = () => { ctx.update(); if(st.full(n)){ st.lonePairs = true; ctx.done(); } };
      st.onMsg = ctx.explain;
    },
    async demo(ctx){ while(ctx.alive() && !ctx.isDone() && await demoBond(ctx.stage, ctx)) await sleep(500); },
  },
  {
    title:'Double bonds',
    text:`Atoms can share more than one pair. Here are two oxygen atoms, each with 6 valence electrons.`,
    task:'Drag the right oxygen next to the left one, so their single electrons meet.',
    after:`Two shared pairs make a <b>double bond</b>, drawn as two lines: <b>O=O</b>. That's the oxygen you breathe! The nitrogen in air shares <b>three</b> pairs: a triple bond, N≡N.
      In the builder, tapping a bond turns it double or triple in just the same way.`,
    setup(ctx){
      const st = ctx.stage; st.gauges = true;
      const a = st.addAtom('O', 150, 140, {layout:[2, 1, 1, 2]});
      st.addAtom('O', 320, 140, {drag:true, layout:[2, 2, 1, 1]});
      st.onBond = () => { ctx.setTask('Each oxygen counts 7 now and still has one single electron. Tap the bond to share a second pair!'); st.sfx.tick(3); };
      st.onTapBond = b => {
        if(b.els.length >= 4) return;
        if(st.promote(b)){ st.lonePairs = true; ctx.done(); }
      };
      st.onMsg = ctx.explain;
      ctx.left = a;
    },
    async demo(ctx){
      const st = ctx.stage;
      if(!st.bonds.length){ await demoBond(st, ctx); await sleep(900); }
      if(ctx.alive() && st.bonds.length) st.onTapBond(st.bonds[0]);
    },
  },
  {
    title:'Your cheat sheet',
    text:`<table class="ltab"><tr><th></th><th>valence e⁻</th><th>bonds</th><th>lone pairs</th></tr>
      <tr><td>H</td><td>1</td><td>1</td><td>0</td></tr><tr><td>C</td><td>4</td><td>4</td><td>0</td></tr>
      <tr><td>N</td><td>5</td><td>3</td><td>1</td></tr><tr><td>O</td><td>6</td><td>2</td><td>2</td></tr></table>
      <p><b>Quick check:</b> fluorine has 7 valence electrons. How many bonds does it make?</p><div class="lquiz"></div>`,
    task:'Pick an answer.',
    after:`Yes! 8 − 7 = 1, so fluorine makes <b>1 bond</b> and keeps 3 lone pairs. You now know why atoms bond the way they do. Go build some molecules!`,
    setup(ctx){
      const st = ctx.stage; st.lonePairs = true; st.lpLabels = false;
      const xs = {H:40, C:120, N:200, O:280, F:360};
      for(const el in xs){
        st.addAtom(el, xs[el], 115);
        const t = svg('text', {x:xs[el], y:178, class:'lcount'}, st.gBack);
        t.textContent = el === 'F' ? '? bonds' : `${{H:1, C:4, N:3, O:2}[el]} bond${el === 'H' ? '' : 's'}`;
        if(el === 'F') ctx.fLabel = t;
      }
      const q = ctx.panel.querySelector('.lquiz');
      for(const n of [1, 2, 3, 7]){
        const b = document.createElement('button'); b.textContent = n;
        b.onclick = () => {
          if(ctx.isDone()) return;
          if(n === 1){ b.classList.add('right'); ctx.fLabel.textContent = '1 bond'; ctx.done(); }
          else { b.classList.add('wrong'); b.disabled = true; st.sfx.err(); ctx.hint(n === 7 ? 'Not quite: 7 is how many it has. How many more does it need to reach 8?' : 'Not quite. It wants 8 and has 7…'); }
        };
        q.appendChild(b);
      }
    },
  },
];

/* ================= the lesson overlay ================= */
let el = null, stage = null, cur = 0, maxSeen = 0, raf = 0, opts = null, ctx = null, gen = 0;

function build(){
  el = document.createElement('div'); el.id = 'lesson'; el.className = 'hidden';
  el.innerHTML = `<div class="lhead"><b>🌱 Atoms &amp; bonds</b><div class="ldots"></div><button class="lx" aria-label="Close the lesson">✕</button></div>
    <svg class="lstage" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid meet"></svg>
    <div class="lpanel"><h3></h3><div class="ltext"></div><div class="ltask"></div><div class="lafter"></div>
      <div class="lnav"><button class="lback">‹ Back</button><button class="lshow">👀 Show me</button><button class="lnext">Next ›</button></div>
      <div class="lend"></div></div>`;
  document.body.appendChild(el);
  stage = new Stage(el.querySelector('.lstage'), opts.sfx);
  el.querySelector('.lx').onclick = close;
  el.querySelector('.lback').onclick = () => { opts.sfx.tick(); go(cur - 1); };
  el.querySelector('.lnext').onclick = () => { opts.sfx.tick(2); if(cur < STEPS.length - 1) go(cur + 1); else close(); };
  el.querySelector('.lshow').onclick = async e => {
    const b = e.currentTarget; if(b.disabled) return; b.disabled = true;
    try{ await STEPS[cur].demo?.(ctx); } finally { b.disabled = false; }
  };
  document.addEventListener('keydown', e => {
    if(el.classList.contains('hidden')) return;
    if(e.key === 'Escape') close();
    else if(e.key === 'ArrowRight' && ctx?.isDone()) go(cur + 1);
    else if(e.key === 'ArrowLeft') go(cur - 1);
  });
}

const MSGS = {
  pair:(a) => `That side of ${NAME[a.el].toLowerCase()} already has a pair of electrons. Pairs don't bond: try a side with a single electron.`,
  full:(a) => `${NAME[a.el]} is already full: no room for another bond.`,
  taken:() => 'That side already has a bond. Try another side.',
  crowded:() => 'Another atom is in the way there. Try a different side.',
  nothing:() => 'There are no electrons on that side.',
};

function go(i){
  if(i < 0 || i >= STEPS.length) return;
  cur = i; maxSeen = Math.max(maxSeen, i); gen++;
  opts.ls.set('qm.lesson', {step:cur, max:maxSeen});
  const s = STEPS[i], panel = el.querySelector('.lpanel'), myGen = gen;
  stage.reset();
  panel.querySelector('h3').textContent = `${i + 1}. ${s.title}`;
  panel.querySelector('.ltext').innerHTML = s.text;
  const task = panel.querySelector('.ltask'), after = panel.querySelector('.lafter');
  after.innerHTML = ''; after.classList.remove('show');
  panel.querySelector('.lend').innerHTML = '';
  let done = false, msgT = 0, base = s.task;
  const show = (t, cls = '') => { task.innerHTML = t; task.className = 'ltask ' + cls; };
  const restore = () => { if(!done) show(`👉 ${base}${s.progress ? ` <span class="lprog">${s.progress(ctx)}</span>` : ''}`); };
  const setTask = t => { base = t; clearTimeout(msgT); restore(); };
  ctx = {
    stage, panel,
    alive:() => gen === myGen,
    isDone:() => done,
    setTask,
    update:() => { clearTimeout(msgT); restore(); },
    explain:(res, who) => {
      show(`🤔 ${(MSGS[res] || MSGS.nothing)(who)}`, 'bad'); clearTimeout(msgT);
      msgT = setTimeout(() => { if(ctx.alive()) restore(); }, 3600);
    },
    hint:t => { show(`🤔 ${t}`, 'bad'); clearTimeout(msgT); msgT = setTimeout(() => { if(ctx.alive()) restore(); }, 3600); },
    done:() => {
      if(done || !ctx.alive()) return; done = true;
      if(s.after){ after.innerHTML = s.after; requestAnimationFrame(() => after.classList.add('show')); }
      clearTimeout(msgT); show(i === STEPS.length - 1 ? '🎉 Lesson complete!' : '✅ Nice! Press Next when you\'re ready.', 'ok');
      opts.sfx.chime();
      nav();
      if(i === STEPS.length - 1) finale(panel);
      setTimeout(() => { if(ctx.alive()) panel.scrollTo({top:panel.scrollHeight, behavior:'smooth'}); }, 450);
    },
  };
  s.setup(ctx);
  restore();
  panel.scrollTop = 0;
  nav();
}
function nav(){
  const s = STEPS[cur], done = ctx.isDone();
  el.querySelector('.lback').disabled = cur === 0;
  const show = el.querySelector('.lshow'); show.style.display = s.demo && !done ? '' : 'none';
  const next = el.querySelector('.lnext');
  next.disabled = !done; next.classList.toggle('go', done);
  next.textContent = cur === STEPS.length - 1 ? 'Finish' : 'Next ›';
  const dots = el.querySelector('.ldots'); dots.innerHTML = '';
  STEPS.forEach((_, k) => {
    const d = document.createElement('button'); d.className = 'ldot' + (k === cur ? ' on' : '') + (k <= maxSeen ? ' seen' : '');
    d.setAttribute('aria-label', `Step ${k + 1}: ${STEPS[k].title}`);
    d.disabled = k > maxSeen; d.onclick = () => { opts.sfx.tick(); go(k); };
    dots.appendChild(d);
  });
}
function finale(panel){
  const end = panel.querySelector('.lend');
  const mk = (text, cls, fn) => { const b = document.createElement('button'); b.textContent = text; b.className = cls; b.onclick = fn; end.appendChild(b); };
  mk('💧 Build water in 3D', 'lgo', () => { close(); opts.onBuild?.('water'); });
  mk('❓ Take the quiz', '', () => { close(); opts.onQuiz?.(); });
  opts.sfx.fanfare?.();
  opts.onFinish?.();
}
function loop(now){ stage.tick(now); raf = requestAnimationFrame(loop); }

export function openLesson(o){
  opts = o;
  if(!el) build();
  const saved = o.ls.get('qm.lesson', null);
  maxSeen = saved ? saved.max : 0;
  el.classList.remove('hidden'); document.body.classList.add('lessoning');
  go(saved && saved.step < STEPS.length - 1 ? saved.step : 0);
  cancelAnimationFrame(raf); raf = requestAnimationFrame(loop);
}
function close(){
  if(!el) return;
  gen++; el.classList.add('hidden'); document.body.classList.remove('lessoning');
  cancelAnimationFrame(raf);
  opts.onClose?.();
}
