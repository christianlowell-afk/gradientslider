const IMAGES = [
  './img/img01.webp', './img/img02.webp', './img/img03.webp', './img/img04.webp',
  './img/img05.webp', './img/img06.webp', './img/img07.webp', './img/img08.webp',
  './img/img09.webp', './img/img10.webp'
];

// DOM references
const stage = document.querySelector('.stage');
const cardsRoot = document.getElementById('cards');
const bgCanvas = document.getElementById('bg');
const bgCtx = bgCanvas?.getContext('2d', { alpha: false });
const loader = document.getElementById('loader');

// State
let items = [];
let positions = [];
let rafId = null;
let lastTime = 0;
let isEntering = true;
let activeIndex = -1;
let VW_HALF = window.innerWidth * 0.5;

// Layout
let CARD_W = 320;
let CARD_H = 400;
let GAP = 28;
let STEP = CARD_W + GAP;
let TRACK = 0;
let SCROLL_X = 0;

// Physics
let vX = 0;
const FRICTION = 0.9;
const WHEEL_SENS = 0.6;
const DRAG_SENS = 1.0;

// Background animation
let gradPalette = [];
// Expanded current gradient to carry two extra accent colors (r3/g3/b3 and r4/g4/b4)
let gradCurrent = {
  r1: 240, g1: 240, b1: 240,
  r2: 235, g2: 235, b2: 235,
  r3: 248, g3: 248, b3: 248,
  r4: 245, g4: 245, b4: 245
};
let bgRAF = null;
let lastBgDraw = 0;
let bgFastUntil = 0;

// Safe modulo
function mod(n, m) {
  return ((n % m) + m) % m;
}

// Preload images with link tags for browser preload
function preloadImageLinks(srcs) {
  if (!document.head) return;
  srcs.forEach(href => {
    const link = document.createElement('link');
    link.rel = 'preload';
    link.as = 'image';
    link.href = href;
    link.fetchPriority = 'high';
    document.head.appendChild(link);
  });
}

// Create card elements
function createCards() {
  cardsRoot.innerHTML = '';
  items = [];
  
  const fragment = document.createDocumentFragment();
  
  IMAGES.forEach((src, i) => {
    const card = document.createElement('article');
    card.className = 'card';
    
    // Force GPU compositing layer immediately
    card.style.willChange = 'transform';
    
    const img = new Image();
    img.className = 'card__img';
    img.decoding = 'async';
    img.loading = 'eager';
    img.fetchPriority = 'high';
    img.draggable = false;
    img.src = src;
    
    card.appendChild(img);
    fragment.appendChild(card);
    items.push({ el: card, x: 0 });
  });
  
  cardsRoot.appendChild(fragment);
}

// Measure card dimensions
function measure() {
  const sample = items[0]?.el;
  if (!sample) return;
  
  const r = sample.getBoundingClientRect();
  CARD_W = r.width || CARD_W;
  CARD_H = r.height || CARD_H;
  STEP = CARD_W + GAP;
  TRACK = items.length * STEP;
  
  items.forEach((it, i) => {
    it.x = i * STEP;
  });
  
  positions = new Float32Array(items.length);
}

// Wait for all images to load
function waitForImages() {
  const promises = items.map(it => {
    const img = it.el.querySelector('img');
    if (!img || img.complete) return Promise.resolve();
    
    return new Promise(resolve => {
      const done = () => resolve();
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    });
  });
  
  return Promise.all(promises);
}

// Decode all images to avoid jank on first interaction
async function decodeAllImages() {
  const tasks = items.map(it => {
    const img = it.el.querySelector('img');
    if (!img) return Promise.resolve();
    
    if (typeof img.decode === 'function') {
      return img.decode().catch(() => {});
    }
    
    return Promise.resolve();
  });
  
  await Promise.allSettled(tasks);
}

// Transform calculation (memoized constants)
const MAX_ROTATION = 28;
const MAX_DEPTH = 140;
const MIN_SCALE = 0.8;
const SCALE_RANGE = 0.20;

function transformForScreenX(screenX) {
  const norm = Math.max(-1, Math.min(1, screenX / VW_HALF));
  const absNorm = Math.abs(norm);
  const invNorm = 1 - absNorm;
  
  const ry = -norm * MAX_ROTATION;
  const tz = invNorm * MAX_DEPTH;
  const scale = MIN_SCALE + invNorm * SCALE_RANGE;
  
  return {
    transform: `translate3d(${screenX}px,-50%,${tz}px) rotateY(${ry}deg) scale(${scale})`,
    z: tz
  };
}

// Update carousel transforms
function updateCarouselTransforms() {
  const half = TRACK / 2;
  let closestIdx = -1;
  let closestDist = Infinity;

  // Calculate wrapped positions
  for (let i = 0; i < items.length; i++) {
    let pos = items[i].x - SCROLL_X;
    if (pos < -half) pos += TRACK;
    if (pos > half) pos -= TRACK;
    positions[i] = pos;
    
    const dist = Math.abs(pos);
    if (dist < closestDist) {
      closestDist = dist;
      closestIdx = i;
    }
  }

  const prevIdx = (closestIdx - 1 + items.length) % items.length;
  const nextIdx = (closestIdx + 1) % items.length;

  // Apply transforms
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const pos = positions[i];
    const norm = Math.max(-1, Math.min(1, pos / VW_HALF));
    const { transform, z } = transformForScreenX(pos);
    
    it.el.style.transform = transform;
    it.el.style.zIndex = String(1000 + Math.round(z));
    
    // Subtle blur on non-active cards
    const isCore = (i === closestIdx);
    const blur = isCore ? 0 : (3 * Math.pow(Math.abs(norm), 1.1));
    it.el.style.filter = `blur(${blur.toFixed(2)}px)`;
  }
  
  if (closestIdx !== activeIndex) {
    setActiveGradient(closestIdx);
  }
}

// Animation loop
function tick(t) {
  const dt = lastTime ? (t - lastTime) / 1000 : 0;
  lastTime = t;
  
  // Integrate velocity
  SCROLL_X = mod(SCROLL_X + vX * dt, TRACK);
  
  // Apply friction
  const decay = Math.pow(FRICTION, dt * 60);
  vX *= decay;
  if (Math.abs(vX) < 0.02) vX = 0;
  
  updateCarouselTransforms();
  rafId = requestAnimationFrame(tick);
}

function startCarousel() {
  cancelCarousel();
  lastTime = 0;
  rafId = requestAnimationFrame(t => {
    updateCarouselTransforms();
    tick(t);
  });
}

function cancelCarousel() {
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
}

// Background canvas setup
function resizeBG() {
  if (!bgCanvas || !bgCtx) return;
  
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const w = bgCanvas.clientWidth || stage.clientWidth;
  const h = bgCanvas.clientHeight || stage.clientHeight;
  const tw = Math.floor(w * dpr);
  const th = Math.floor(h * dpr);
  
  if (bgCanvas.width !== tw || bgCanvas.height !== th) {
    bgCanvas.width = tw;
    bgCanvas.height = th;
    bgCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
}

// Color utilities
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h, s, l = (max + min) / 2;
  
  if (max === min) {
    h = 0;
    s = 0;
  } else {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      default: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  
  return [h * 360, s, l];
}

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  h /= 360;
  let r, g, b;
  
  if (s === 0) {
    r = g = b = l;
  } else {
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1/6) return p + (q - p) * 6 * t;
      if (t < 1/2) return q;
      if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue2rgb(p, q, h + 1/3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1/3);
  }
  
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function fallbackFromIndex(idx) {
  const h = (idx * 37) % 360;
  const s = 0.65;
  const c1 = hslToRgb(h, s, 0.52);
  const c2 = hslToRgb(h, s, 0.72);
  return { c1, c2 };
}

// Extract colors from image
function extractColors(img, idx) {
  try {
    const MAX = 48;
    const ratio = img.naturalWidth && img.naturalHeight ? 
      img.naturalWidth / img.naturalHeight : 1;
    const tw = ratio >= 1 ? MAX : Math.max(16, Math.round(MAX * ratio));
    const th = ratio >= 1 ? Math.max(16, Math.round(MAX / ratio)) : MAX;
    
    const canvas = document.createElement('canvas');
    canvas.width = tw;
    canvas.height = th;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, tw, th);
    const data = ctx.getImageData(0, 0, tw, th).data;

    const H_BINS = 36;
    const S_BINS = 5;
    const SIZE = H_BINS * S_BINS;
    const wSum = new Float32Array(SIZE);
    const rSum = new Float32Array(SIZE);
    const gSum = new Float32Array(SIZE);
    const bSum = new Float32Array(SIZE);

    for (let i = 0; i < data.length; i += 4) {
      const a = data[i + 3] / 255;
      if (a < 0.05) continue;
      
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const [h, s, l] = rgbToHsl(r, g, b);
      
      if (l < 0.10 || l > 0.92 || s < 0.08) continue;
      
      const w = a * (s * s) * (1 - Math.abs(l - 0.5) * 0.6);
      const hi = Math.max(0, Math.min(H_BINS - 1, Math.floor((h / 360) * H_BINS)));
      const si = Math.max(0, Math.min(S_BINS - 1, Math.floor(s * S_BINS)));
      const bidx = hi * S_BINS + si;
      
      wSum[bidx] += w;
      rSum[bidx] += r * w;
      gSum[bidx] += g * w;
      bSum[bidx] += b * w;
    }

    // Build top bins by weight
    const indices = [];
    for (let i = 0; i < SIZE; i++) if (wSum[i] > 0) indices.push(i);
    if (indices.length === 0) return fallbackFromIndex(idx);

    indices.sort((a, b) => wSum[b] - wSum[a]);

    const hueOf = i => Math.floor(i / S_BINS) * (360 / H_BINS);
    const hueDist = (a, b) => {
      let d = Math.abs(a - b);
      return Math.min(d, 360 - d);
    };

    // Pick up to 4 distinct hue clusters with spacing
    const picks = [];
    const minHueGap = 32; // ensure noticeably different hues
    const refWeight = wSum[indices[0]] || 1e-6;
    for (let k = 0; k < indices.length && picks.length < 4; k++) {
      const i = indices[k];
      const w = wSum[i];
      if (w < refWeight * 0.22) break; // ignore very small clusters
      const h = hueOf(i);
      let ok = true;
      for (let j = 0; j < picks.length; j++) {
        if (hueDist(h, hueOf(picks[j])) < minHueGap) { ok = false; break; }
      }
      if (ok) picks.push(i);
    }
    if (picks.length === 0) return fallbackFromIndex(idx);

    const pIdx = picks[0];
    const pHue = hueOf(pIdx);

    const avgRGB = idx => {
      const w = wSum[idx] || 1e-6;
      return [
        Math.round(rSum[idx] / w),
        Math.round(gSum[idx] / w),
        Math.round(bSum[idx] / w)
      ];
    };
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const toRGBFromIdx = (i, L) => {
      const [r, g, b] = avgRGB(i);
      let [h, s] = rgbToHsl(r, g, b);
      s = clamp(s * 0.92, 0.30, 0.78); // slightly toned-down saturation for subtlety
      return hslToRgb(h, s, L);
    };

    const c1 = toRGBFromIdx(pIdx, 0.50);
    // Choose next distinct hues as accents; if not enough picks, derive from primary
    const sIdx = picks[1] ?? pIdx;
    const tIdx = picks[2] ?? pIdx;
    const uIdx = picks[3] ?? pIdx;

    const c2 = toRGBFromIdx(sIdx, 0.68);
    const c3 = toRGBFromIdx(tIdx, 0.60);
    const c4 = toRGBFromIdx(uIdx, 0.72);

    return { c1, c2, c3, c4 };
  } catch {
    return fallbackFromIndex(idx);
  }
}

function buildPalette() {
  gradPalette = items.map((it, i) => {
    const img = it.el.querySelector('img');
    const pal = extractColors(img, i);
    // Ensure extras exist for downstream drawing
    if (!pal.c3 || !pal.c4) {
      const mixW = (c, t) => Math.round(c + (255 - c) * t);
      const c3 = [mixW(pal.c1[0], 0.10), mixW(pal.c1[1], 0.10), mixW(pal.c1[2], 0.10)];
      const c4 = [mixW(pal.c2[0], 0.15), mixW(pal.c2[1], 0.15), mixW(pal.c2[2], 0.15)];
      return { ...pal, c3, c4 };
    }
    return pal;
  });
}

function setActiveGradient(idx) {
  if (!bgCtx || idx < 0 || idx >= items.length || idx === activeIndex) return;
  
  activeIndex = idx;
  const pal = gradPalette[idx] || { c1: [240, 240, 240], c2: [235, 235, 235], c3: [248,248,248], c4: [245,245,245] };
  const to = {
    r1: pal.c1[0], g1: pal.c1[1], b1: pal.c1[2],
    r2: pal.c2[0], g2: pal.c2[1], b2: pal.c2[2],
    r3: pal.c3 ? pal.c3[0] : Math.round(pal.c1[0] + (255 - pal.c1[0]) * 0.10),
    g3: pal.c3 ? pal.c3[1] : Math.round(pal.c1[1] + (255 - pal.c1[1]) * 0.10),
    b3: pal.c3 ? pal.c3[2] : Math.round(pal.c1[2] + (255 - pal.c1[2]) * 0.10),
    r4: pal.c4 ? pal.c4[0] : Math.round(pal.c2[0] + (255 - pal.c2[0]) * 0.15),
    g4: pal.c4 ? pal.c4[1] : Math.round(pal.c2[1] + (255 - pal.c2[1]) * 0.15),
    b4: pal.c4 ? pal.c4[2] : Math.round(pal.c2[2] + (255 - pal.c2[2]) * 0.15)
  };
  
  if (window.gsap) {
    bgFastUntil = performance.now() + 800;
    window.gsap.to(gradCurrent, { ...to, duration: 0.55, ease: 'power2.out' });
  } else {
    Object.assign(gradCurrent, to);
  }
}

// Background rendering
function drawBackground() {
  if (!bgCanvas || !bgCtx) return;
  
  const now = performance.now();
  // Render faster only while gradient colors are transitioning
  const quick = (now < bgFastUntil);
  const minInterval = quick ? 16 : 33; // ~60fps when quick, ~30fps idle
  
  if (now - lastBgDraw < minInterval) {
    bgRAF = requestAnimationFrame(drawBackground);
    return;
  }
  
  lastBgDraw = now;
  resizeBG();
  
  const w = bgCanvas.clientWidth || stage.clientWidth;
  const h = bgCanvas.clientHeight || stage.clientHeight;
  
  bgCtx.fillStyle = '#f6f7f9';
  bgCtx.fillRect(0, 0, w, h);
  
  const time = now * 0.00032; // slightly faster for more motion
  const cx = w * 0.5;
  const cy = h * 0.5;
  const a1 = Math.min(w, h) * 0.36;
  const a2 = Math.min(w, h) * 0.30;
  const a3 = Math.min(w, h) * 0.24;
  const a4 = Math.min(w, h) * 0.20;
  const a5 = Math.min(w, h) * 0.26;
  const a6 = Math.min(w, h) * 0.22;
  
  // Time-driven motion only (no coupling to scroll/drag)
  const swirl = time * 0.35; // slow global rotation
  const drift = time * 0.22; // constant drift to ensure continuous motion
  const sway = 0.15; // small constant sway for subtle breathing
  const pulse = 0.92 + 0.08 * Math.sin(time * 1.8);
  
  const x1 = cx + Math.cos(time + swirl + drift) * a1 * (1 + sway * 0.5);
  const y1 = cy + Math.sin(time * 0.8 + swirl * 0.9 + drift * 0.7) * a1 * 0.45 * (1 + sway * 0.5);
  const x2 = cx + Math.cos(-time * 0.9 + 1.2 + swirl * 0.6 + drift * 0.6) * a2 * (1 + sway * 0.4);
  const y2 = cy + Math.sin(-time * 0.7 + 0.7 + swirl * 0.5 + drift * 0.5) * a2 * 0.5 * (1 + sway * 0.4);
  const x3 = cx + Math.cos(time * 1.6 + swirl * 0.4 + 0.7 + drift * 1.1) * a3 * (1 + sway * 0.3);
  const y3 = cy + Math.sin(time * 1.2 + swirl * 0.3 + 1.7 + drift * 0.9) * a3 * 0.6 * (1 + sway * 0.3);
  const x4 = cx + Math.cos(-time * 1.3 + swirl * 1.0 + 2.2 + drift * 0.8) * a4 * (1 + sway * 0.2);
  const y4 = cy + Math.sin(-time * 1.5 + swirl * 0.8 + 0.9 + drift * 0.6) * a4 * 0.7 * (1 + sway * 0.2);
  const x5 = cx + Math.cos(time * 1.1 + swirl * 0.6 + 1.3 - drift * 0.7) * a5 * (1 + sway * 0.25);
  const y5 = cy + Math.sin(time * 0.9 + swirl * 0.7 + 0.3 - drift * 0.5) * a5 * 0.55 * (1 + sway * 0.25);
  const x6 = cx + Math.cos(-time * 1.4 + swirl * 0.4 + 2.7 + drift * 0.4) * a6 * (1 + sway * 0.22);
  const y6 = cy + Math.sin(-time * 1.1 + swirl * 0.5 + 1.1 + drift * 0.3) * a6 * 0.6 * (1 + sway * 0.22);
  
  const rBase = Math.max(w, h);
  const r1 = rBase * (0.70 + 0.06 * pulse);
  const r2 = rBase * (0.60 + 0.05 * Math.cos(time * 1.4 + 0.5));
  const r3 = rBase * (0.50 + 0.06 * Math.sin(time * 1.8));
  const r4 = rBase * (0.44 + 0.05 * Math.cos(time * 1.3 + 1.1));
  const r5 = rBase * (0.40 + 0.05 * Math.sin(time * 1.1 + 0.8));
  const r6 = rBase * (0.36 + 0.05 * Math.cos(time * 1.5 + 0.2));
  
  const g1 = bgCtx.createRadialGradient(x1, y1, 0, x1, y1, r1);
  g1.addColorStop(0, `rgba(${gradCurrent.r1},${gradCurrent.g1},${gradCurrent.b1},0.68)`);
  g1.addColorStop(1, 'rgba(255,255,255,0)');
  bgCtx.fillStyle = g1;
  bgCtx.fillRect(0, 0, w, h);
  
  const g2 = bgCtx.createRadialGradient(x2, y2, 0, x2, y2, r2);
  g2.addColorStop(0, `rgba(${gradCurrent.r2},${gradCurrent.g2},${gradCurrent.b2},0.55)`);
  g2.addColorStop(1, 'rgba(255,255,255,0)');
  bgCtx.fillStyle = g2;
  bgCtx.fillRect(0, 0, w, h);
  
  // Additional subtle blobs for more colors and motion
  const c3 = `rgba(${gradCurrent.r3},${gradCurrent.g3},${gradCurrent.b3},0.38)`;
  const c4 = `rgba(${gradCurrent.r4},${gradCurrent.g4},${gradCurrent.b4},0.30)`;

  const g3 = bgCtx.createRadialGradient(x3, y3, 0, x3, y3, r3);
  g3.addColorStop(0, c3);
  g3.addColorStop(1, 'rgba(255,255,255,0)');
  bgCtx.fillStyle = g3;
  bgCtx.fillRect(0, 0, w, h);
  
  const g4 = bgCtx.createRadialGradient(x4, y4, 0, x4, y4, r4);
  g4.addColorStop(0, c4);
  g4.addColorStop(1, 'rgba(255,255,255,0)');
  bgCtx.fillStyle = g4;
  bgCtx.fillRect(0, 0, w, h);

  // Two extra very subtle blobs for continuous movement and richness
  const g5 = bgCtx.createRadialGradient(x5, y5, 0, x5, y5, r5);
  g5.addColorStop(0, `rgba(${gradCurrent.r1},${gradCurrent.g1},${gradCurrent.b1},0.22)`);
  g5.addColorStop(1, 'rgba(255,255,255,0)');
  bgCtx.fillStyle = g5;
  bgCtx.fillRect(0, 0, w, h);

  const g6 = bgCtx.createRadialGradient(x6, y6, 0, x6, y6, r6);
  g6.addColorStop(0, `rgba(${gradCurrent.r2},${gradCurrent.g2},${gradCurrent.b2},0.20)`);
  g6.addColorStop(1, 'rgba(255,255,255,0)');
  bgCtx.fillStyle = g6;
  bgCtx.fillRect(0, 0, w, h);
  
  bgRAF = requestAnimationFrame(drawBackground);
}

function startBG() {
  if (!bgCanvas || !bgCtx) return;
  cancelBG();
  bgRAF = requestAnimationFrame(drawBackground);
}

function cancelBG() {
  if (bgRAF) cancelAnimationFrame(bgRAF);
  bgRAF = null;
}

// Resize handler
function onResize() {
  const prevStep = STEP || 1;
  const ratio = SCROLL_X / (items.length * prevStep);
  measure();
  VW_HALF = window.innerWidth * 0.5;
  SCROLL_X = mod(ratio * TRACK, TRACK);
  updateCarouselTransforms();
  resizeBG();
}

// Input handlers
stage.addEventListener('wheel', e => {
  if (isEntering) return;
  e.preventDefault();
  
  const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
  vX += delta * WHEEL_SENS * 20;
}, { passive: false });

stage.addEventListener('dragstart', e => e.preventDefault());

let dragging = false;
let lastX = 0;
let lastT = 0;
let lastDelta = 0;

stage.addEventListener('pointerdown', e => {
  if (isEntering) return;
  dragging = true;
  lastX = e.clientX;
  lastT = performance.now();
  lastDelta = 0;
  stage.setPointerCapture(e.pointerId);
  stage.classList.add('dragging');
});

stage.addEventListener('pointermove', e => {
  if (!dragging) return;
  
  const now = performance.now();
  const dx = e.clientX - lastX;
  const dt = Math.max(1, now - lastT) / 1000;
  
  SCROLL_X = mod(SCROLL_X - dx * DRAG_SENS, TRACK);
  lastDelta = dx / dt;
  lastX = e.clientX;
  lastT = now;
});

stage.addEventListener('pointerup', e => {
  if (!dragging) return;
  dragging = false;
  stage.releasePointerCapture(e.pointerId);
  vX = -lastDelta * DRAG_SENS;
  stage.classList.remove('dragging');
});

window.addEventListener('resize', () => {
  clearTimeout(onResize._t);
  onResize._t = setTimeout(onResize, 80);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    cancelCarousel();
    cancelBG();
  } else {
    startCarousel();
    startBG();
  }
});

// Force composite layer creation and paint for ALL items
async function warmupCompositing() {
  const originalScrollX = SCROLL_X;
  const stepSize = STEP * 0.5; // Half a card width
  const numSteps = Math.ceil(TRACK / stepSize);
  
  // Scroll through the entire carousel to force compositing of all cards
  for (let i = 0; i < numSteps; i++) {
    SCROLL_X = mod(originalScrollX + i * stepSize, TRACK);
    updateCarouselTransforms();
    
    // Force paint for every few steps (don't need every single frame)
    if (i % 3 === 0) {
      await new Promise(r => requestAnimationFrame(r));
    }
  }
  
  // Return to original position
  SCROLL_X = originalScrollX;
  updateCarouselTransforms();
  await new Promise(r => requestAnimationFrame(r));
  await new Promise(r => requestAnimationFrame(r));
}

// Initialize
async function init() {
  preloadImageLinks(IMAGES);
  createCards();
  measure();
  updateCarouselTransforms();
  stage.classList.add('carousel-mode');
  
  // Wait for all images to load
  await waitForImages();
  
  // Decode all images (critical for smooth first interaction)
  await decodeAllImages();
  
  // Force images to be painted by accessing offsetHeight
  items.forEach(it => {
    const img = it.el.querySelector('img');
    if (img) void img.offsetHeight;
  });
  
  // Build color palette
  buildPalette();
  
  // Set initial gradient
  const half = TRACK / 2;
  let closestIdx = 0;
  let closestDist = Infinity;
  
  for (let i = 0; i < items.length; i++) {
    let pos = items[i].x - SCROLL_X;
    if (pos < -half) pos += TRACK;
    if (pos > half) pos -= TRACK;
    const d = Math.abs(pos);
    if (d < closestDist) {
      closestDist = d;
      closestIdx = i;
    }
  }
  
  setActiveGradient(closestIdx);
  
  // Warmup: move carousel slightly to force all layers to composite
  await warmupCompositing();
  
  // Extra safety: wait for idle
  if ('requestIdleCallback' in window) {
    await new Promise(r => requestIdleCallback(r, { timeout: 100 }));
  }
  
  // Hide loader and start
  if (loader) loader.classList.add('loader--hide');
  isEntering = false;
  
  startCarousel();
  startBG();
}

init();
