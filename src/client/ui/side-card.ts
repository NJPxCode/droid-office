// Per-theme animated artwork layers for the companion's sidebar floor card (.dash-side-head).
// Each animated theme (every artwork theme with a backdrop stage) gets a bespoke vector scene
// anchored to the card edges so the left text column stays calm and readable at every width.
// Animations are pure GPU-composited transforms/opacity in style.css, paused cleanly by
// body[data-motion="still"] and prefers-reduced-motion: reduce.

import type { CompanionTheme, CompanionThemeId } from '../../shared/companion-themes';

const SVG_NS = 'http://www.w3.org/2000/svg';

type Attrs = Record<string, string | number | undefined>;

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Node[]): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined) node.setAttribute(k, String(v));
  }
  if (children.length) node.append(...children);
  return node;
}

function stop(offset: string | number, color: string, opacity?: number): SVGStopElement {
  return el('stop', { offset, 'stop-color': color, 'stop-opacity': opacity });
}

function rootSvg(...children: Node[]): SVGSVGElement {
  return el('svg', { class: 'dash-side-fx-svg', width: '100%', height: '100%', fill: 'none', 'aria-hidden': 'true' }, ...children);
}

/** 1. Carbon's Copy: forged carbon sheen, machined corner bracket + beacon, hearth glow and rising sparks. */
function carbonsCopySvg(): SVGSVGElement {
  const defs = el(
    'defs',
    {},
    el(
      'linearGradient',
      { id: 'sc-cc-sheen', x1: '0', y1: '0', x2: '1', y2: '1' },
      stop('0%', '#ffffff', 0),
      stop('44%', '#ffffff', 0),
      stop('50%', '#ffffff', 0.085),
      stop('56%', '#ffb067', 0.045),
      stop('62%', '#ffffff', 0),
      stop('100%', '#ffffff', 0),
    ),
    el('radialGradient', { id: 'sc-cc-hearth', cx: '92%', cy: '105%', r: '58%' }, stop('0%', '#ff6a1f', 0.34), stop('46%', '#ff7a2b', 0.11), stop('78%', '#7484ff', 0.06), stop('100%', '#ff6a1f', 0)),
    el('radialGradient', { id: 'sc-cc-spark-hot', cx: '50%', cy: '50%', r: '50%' }, stop('0%', '#fff0d6', 1), stop('45%', '#ff8c38', 0.85), stop('100%', '#ff6a1f', 0)),
    el('radialGradient', { id: 'sc-cc-spark-arc', cx: '50%', cy: '50%', r: '50%' }, stop('0%', '#eef2ff', 1), stop('45%', '#7484ff', 0.8), stop('100%', '#7484ff', 0)),
  );

  // Diagonal clear-coat carbon specular sheen
  const sheen = el('rect', { class: 'sc-cc-sheen', x: '-60%', y: '-40%', width: '220%', height: '180%', fill: 'url(#sc-cc-sheen)' });
  // Warm lower-right forge hearth breath
  const hearth = el('rect', { class: 'sc-cc-glow', width: '100%', height: '100%', fill: 'url(#sc-cc-hearth)' });

  // Starboard machined telemetry corner bracket & rising forge sparks
  const sparks: [number, number, number, string, string][] = [
    [-18, 86, 2.2, 'sc-cc-s1', 'url(#sc-cc-spark-hot)'],
    [-34, 92, 1.8, 'sc-cc-s2', 'url(#sc-cc-spark-hot)'],
    [-54, 88, 1.5, 'sc-cc-s3', 'url(#sc-cc-spark-hot)'],
    [-25, 96, 1.4, 'sc-cc-s4', 'url(#sc-cc-spark-hot)'],
    [-70, 94, 1.7, 'sc-cc-s5', 'url(#sc-cc-spark-arc)'],
    [-42, 95, 2.0, 'sc-cc-s6', 'url(#sc-cc-spark-hot)'],
  ];

  const starboard = el(
    'svg',
    { x: '100%', y: '0', width: '1', height: '1', overflow: 'visible' },
    // Machined corner L-bracket + precision index ticks
    el('path', { d: 'M-46 10h34l2 2v18', stroke: '#ffffff', 'stroke-opacity': 0.14, 'stroke-width': 1 }),
    el('path', { d: 'M-42 14h22m-32-4v3m-6-3v2m-6-2v2', stroke: '#ff7a2b', 'stroke-opacity': 0.34, 'stroke-width': 1 }),
    el('path', { d: 'M-14 36v14m0 5v6', stroke: '#7484ff', 'stroke-opacity': 0.24, 'stroke-width': 1 }),
    // Calm telemetry LED dot inside corner bracket
    el('circle', { class: 'sc-cc-led-halo', cx: -16, cy: 16, r: 5, fill: '#ff6a1f', opacity: 0.25 }),
    el('circle', { class: 'sc-cc-led', cx: -16, cy: 16, r: 1.6, fill: '#ff975d' }),
    // Rising embers
    ...sparks.map(([cx, cy, r, cls, fill]) => el('g', { class: `sc-cc-spark ${cls}` }, el('circle', { cx, cy, r: r * 2.1, fill, opacity: 0.55 }), el('circle', { cx, cy, r: r * 0.65, fill: '#fff5e4' }))),
  );

  return rootSvg(defs, hearth, sheen, starboard);
}

/** 2. Nightly Orbit: planetary dawn limb, animated tilted orbital chart, orbiting probe/moon, stars and shooting star. */
function nightlyOrbitSvg(): SVGSVGElement {
  const defs = el(
    'defs',
    {},
    el('radialGradient', { id: 'sc-no-dawn', cx: '96%', cy: '124%', r: '62%' }, stop('0%', '#ffb48b', 0.42), stop('28%', '#a97bff', 0.24), stop('62%', '#412c47', 0.12), stop('100%', '#0c1129', 0)),
    el('linearGradient', { id: 'sc-no-meteor-g', x1: '0', y1: '0', x2: '1', y2: '0' }, stop('0%', '#ffffff', 0), stop('72%', '#cbb8ff', 0.65), stop('100%', '#fff3e8', 1)),
    el('radialGradient', { id: 'sc-no-probe-g', cx: '50%', cy: '50%', r: '50%' }, stop('0%', '#fff2e2', 1), stop('40%', '#ffb08a', 0.8), stop('100%', '#ffb08a', 0)),
  );

  // Breathing dawn horizon terminator glow
  const dawn = el('rect', { class: 'sc-no-limb', width: '100%', height: '100%', fill: 'url(#sc-no-dawn)' });

  // Starboard orbital chart centered vertically on the right edge.
  // Satellites sit at (0, 0) inside the tilted orbital plane and follow exact elliptical keyframes
  // in style.css so the probe, halo and moon stay undistorted circles at every angle.
  const outerSat = el(
    'g',
    { class: 'sc-no-sat1' },
    el('circle', { cx: 0, cy: 0, r: 9.5, fill: 'url(#sc-no-probe-g)', opacity: 0.72 }),
    el('circle', { cx: 0, cy: 0, r: 4.5, stroke: '#cf9ac9', 'stroke-width': 0.9, opacity: 0.58 }),
    el('circle', { cx: 0, cy: 0, r: 2.0, fill: '#ffe0c8' }),
  );

  const innerSat = el('g', { class: 'sc-no-sat2' }, el('circle', { cx: 0, cy: 0, r: 5.5, fill: '#b4adff', opacity: 0.28 }), el('circle', { cx: 0, cy: 0, r: 1.7, fill: '#e6deff' }));

  const stars: [number, number, number, string][] = [
    [-108, -32, 1.0, 'sc-no-st1'],
    [-76, -35, 1.3, 'sc-no-st2'],
    [-38, -32, 0.9, 'sc-no-st3'],
    [-112, 18, 1.0, 'sc-no-st4'],
    [-92, 31, 1.1, 'sc-no-st5'],
    [-54, 22, 0.85, 'sc-no-st6'],
    [-20, -16, 1.15, 'sc-no-st7'],
  ];

  const chart = el(
    'svg',
    { x: '100%', y: '50%', width: '1', height: '1', overflow: 'visible' },
    // Tilted orbital plane
    el(
      'g',
      { transform: 'translate(54 18) rotate(-19)' },
      el('ellipse', { rx: 138, ry: 48, stroke: '#9a87db', 'stroke-width': 0.85, opacity: 0.36 }),
      el('ellipse', { class: 'sc-no-dash', rx: 111, ry: 36, stroke: '#b9a6ff', 'stroke-width': 0.85, 'stroke-dasharray': '2 6', opacity: 0.34 }),
      el('ellipse', { rx: 82, ry: 25, stroke: '#9a87db', 'stroke-width': 0.85, opacity: 0.34 }),
      // Calibration axis ticks
      el('path', { d: 'M-151 0h42m-25-5v10m45-5h16m-9-4v8', stroke: '#9a87db', 'stroke-width': 0.85, opacity: 0.55 }),
      outerSat,
      innerSat,
    ),
    // Reticle star placed in clear starboard sky away from the mission badge
    el('path', { class: 'sc-no-reticle', d: 'M-95-24h6m-3-3v6', stroke: '#cbb8ff', 'stroke-width': 0.95 }),
    // Twinkling stars
    ...stars.map(([cx, cy, r, cls]) => el('circle', { class: `sc-no-star ${cls}`, cx, cy, r, fill: '#ece4ff' })),
    // Periodic micro shooting star
    el('g', { class: 'sc-no-meteor' }, el('line', { x1: 0, y1: 0, x2: 34, y2: 0, stroke: 'url(#sc-no-meteor-g)', 'stroke-width': 1.1, 'stroke-linecap': 'round' })),
  );

  return rootSvg(defs, dawn, chart);
}

/** 3. Neo Tokyo: Shibaura wet glass neon reflections, sliding raindrops, canal ripples and glass sheen. */
function neoTokyoSvg(): SVGSVGElement {
  const defs = el(
    'defs',
    {},
    el('linearGradient', { id: 'sc-nt-cyan', x1: '0', y1: '0', x2: '0', y2: '1' }, stop('0%', '#83f5ff', 0.92), stop('52%', '#39caee', 0.55), stop('100%', '#39caee', 0)),
    el('linearGradient', { id: 'sc-nt-rose', x1: '0', y1: '0', x2: '0', y2: '1' }, stop('0%', '#ff82bd', 0.88), stop('60%', '#ff428a', 0.4), stop('100%', '#ff428a', 0)),
    el('linearGradient', { id: 'sc-nt-drop-c', x1: '0', y1: '0', x2: '0', y2: '1' }, stop('0%', '#9feaff', 0), stop('70%', '#9feaff', 0.55), stop('100%', '#ffffff', 0.95)),
    el('linearGradient', { id: 'sc-nt-drop-r', x1: '0', y1: '0', x2: '0', y2: '1' }, stop('0%', '#ff8cc0', 0), stop('70%', '#ff8cc0', 0.5), stop('100%', '#ffd8ec', 0.9)),
    el(
      'linearGradient',
      { id: 'sc-nt-sheen', x1: '0', y1: '0', x2: '1', y2: '0.4' },
      stop('0%', '#2fe0ff', 0),
      stop('46%', '#2fe0ff', 0),
      stop('50%', '#9feaff', 0.09),
      stop('54%', '#ff599d', 0.06),
      stop('60%', '#ff599d', 0),
      stop('100%', '#ff599d', 0),
    ),
  );

  const sheen = el('rect', { class: 'sc-nt-sheen', x: '-60%', y: '-20%', width: '220%', height: '140%', fill: 'url(#sc-nt-sheen)' });

  // Vertical neon reflections + sliding rain streaks on the starboard wet glass
  const drops: [number, number, number, string, string][] = [
    [-12, 20, 0.95, 'sc-nt-r1', 'url(#sc-nt-drop-c)'],
    [-25, 26, 1.0, 'sc-nt-r2', 'url(#sc-nt-drop-r)'],
    [-41, 18, 0.85, 'sc-nt-r3', 'url(#sc-nt-drop-c)'],
    [-56, 24, 0.95, 'sc-nt-r4', 'url(#sc-nt-drop-c)'],
    [-72, 16, 0.8, 'sc-nt-r5', 'url(#sc-nt-drop-r)'],
    [-19, 15, 0.8, 'sc-nt-r6', 'url(#sc-nt-drop-c)'],
    [-48, 21, 0.9, 'sc-nt-r7', 'url(#sc-nt-drop-r)'],
  ];

  const starboard = el(
    'svg',
    { x: '100%', y: '0', width: '1', height: '1', overflow: 'visible' },
    // Neon reflections in wet glass (breathing + rare subtle ballast micro-flicker on bar 2)
    el('path', { class: 'sc-nt-bar sc-nt-b1', fill: 'url(#sc-nt-cyan)', d: 'M-14 0h3v24h-3z M-13 28h1v44h-1z' }),
    el('path', { class: 'sc-nt-bar sc-nt-b2', fill: 'url(#sc-nt-cyan)', d: 'M-22 0h1v9h-1z M-22 14h1v36h-1z' }),
    el('path', { class: 'sc-nt-bar sc-nt-b3', fill: 'url(#sc-nt-rose)', d: 'M-31 0h4v13h-4z M-30 17h2v32h-2z M-37 0h1v24h-1z' }),
    el('path', { class: 'sc-nt-bar sc-nt-b4', fill: 'url(#sc-nt-cyan)', d: 'M-46 0h1.5v16h-1.5z M-46 20h1v18h-1z', opacity: 0.45 }),
    // Sliding raindrops
    ...drops.map(([x, len, w, cls, stroke]) =>
      el('g', { class: `sc-nt-rain ${cls}` }, el('line', { x1: x, y1: -len, x2: x, y2: 0, stroke, 'stroke-width': w, 'stroke-linecap': 'round' }), el('circle', { cx: x, cy: 0, r: w * 0.78, fill: '#ffffff', opacity: 0.72 })),
    ),
  );

  // Shibaura canal water reflection ripples anchored beneath the starboard neon pane
  const bottom = el(
    'svg',
    { x: '100%', y: '100%', width: '1', height: '1', overflow: 'visible' },
    el('path', { class: 'sc-nt-ripple sc-nt-rip1', stroke: '#fd65a1', 'stroke-width': 1, opacity: 0.5, d: 'M-64-13h16m5 0h12M-52-9h24' }),
    el('path', { class: 'sc-nt-ripple sc-nt-rip2', stroke: '#6bdff7', 'stroke-width': 1, opacity: 0.44, d: 'M-78-6h34m6 0h14' }),
  );

  return rootSvg(defs, sheen, starboard, bottom);
}

/** 4. Kyoto Firefly: backlit washi shoji warmth, cedar lattice, pond ripples and wandering fireflies. */
function kyotoFireflySvg(): SVGSVGElement {
  const defs = el(
    'defs',
    {},
    el('radialGradient', { id: 'sc-kf-lantern', cx: '94%', cy: '42%', r: '56%' }, stop('0%', '#f3c45a', 0.28), stop('38%', '#8c6028', 0.16), stop('74%', '#1c3b2f', 0.08), stop('100%', '#061510', 0)),
    el('radialGradient', { id: 'sc-kf-halo-gold', cx: '50%', cy: '50%', r: '50%' }, stop('0%', '#fff8cc', 1), stop('32%', '#ffd76a', 0.72), stop('100%', '#ffd76a', 0)),
    el('radialGradient', { id: 'sc-kf-halo-lime', cx: '50%', cy: '50%', r: '50%' }, stop('0%', '#f5ffd4', 1), stop('32%', '#c9ff7a', 0.72), stop('100%', '#4fd1a1', 0)),
    el('linearGradient', { id: 'sc-kf-shoji-mask', x1: '0', y1: '0', x2: '1', y2: '0' }, stop('0%', '#ffffff', 0), stop('46%', '#ffffff', 0.08), stop('76%', '#ffffff', 0.78), stop('100%', '#ffffff', 1)),
    el('mask', { id: 'sc-kf-fade' }, el('rect', { width: '100%', height: '100%', fill: 'url(#sc-kf-shoji-mask)' })),
  );

  // Soft breathing lantern warmth behind the shoji paper
  const lantern = el('rect', { class: 'sc-kf-lantern', width: '100%', height: '100%', fill: 'url(#sc-kf-lantern)' });

  // Delicate cedar-and-gold shoji mullions fading cleanly away from the left text column
  const mullions = el(
    'svg',
    { x: '100%', y: '0', width: '1', height: '1', overflow: 'visible' },
    el('path', { d: 'M-29 0v130M-58 0v130M-87 0v130M-116 0v130M-130 24h130M-130 48h130M-130 72h130M-130 96h130', stroke: '#0b1511', 'stroke-width': 1.8, 'stroke-opacity': 0.65 }),
    el('path', { d: 'M-28 0v130M-57 0v130M-86 0v130M-115 0v130M-130 25h130M-130 49h130M-130 73h130M-130 97h130', stroke: '#d8b464', 'stroke-width': 0.7, 'stroke-opacity': 0.24 }),
  );
  const shojiGroup = el('g', { mask: 'url(#sc-kf-fade)' }, mullions);

  // Tranquil pond ripples + 6 wandering bioluminescent fireflies on the starboard garden side
  const flies: [number, number, number, string, string][] = [
    [-24, 28, 7.6, 'sc-kf-f1', 'url(#sc-kf-halo-gold)'],
    [-62, 50, 6.6, 'sc-kf-f2', 'url(#sc-kf-halo-lime)'],
    [-40, 72, 8.0, 'sc-kf-f3', 'url(#sc-kf-halo-gold)'],
    [-84, 26, 5.8, 'sc-kf-f4', 'url(#sc-kf-halo-gold)'],
    [-16, 62, 6.2, 'sc-kf-f5', 'url(#sc-kf-halo-lime)'],
    [-90, 46, 5.4, 'sc-kf-f6', 'url(#sc-kf-halo-gold)'],
  ];

  const garden = el(
    'svg',
    { x: '100%', y: '0', width: '1', height: '1', overflow: 'visible' },
    // Expanding pond ripples at lower right
    el('ellipse', { class: 'sc-kf-ripple sc-kf-rp1', cx: -46, cy: 84, rx: 28, ry: 8, stroke: '#b9e7af', 'stroke-width': 0.85 }),
    el('ellipse', { class: 'sc-kf-ripple sc-kf-rp2', cx: -46, cy: 84, rx: 28, ry: 8, stroke: '#f3c45a', 'stroke-width': 0.75 }),
    // Wandering fireflies (outer group wanders, inner dot blinks organically)
    ...flies.map(([cx, cy, r, cls, fill]) => el('g', { class: `sc-kf-fly ${cls}` }, el('g', { class: 'sc-kf-blink' }, el('circle', { cx, cy, r, fill }), el('circle', { cx, cy, r: Math.max(1.2, r * 0.22), fill: '#fffbe0' })))),
  );

  return rootSvg(defs, lantern, shojiGroup, garden);
}

/** 5. Orbital Foundry: heat-blued temper sweep, riveted chamfered deck plate, forge under-glow and rising sparks. */
function orbitalFoundrySvg(): SVGSVGElement {
  const defs = el(
    'defs',
    {},
    // Straw -> bronze -> plum -> temper-blue alloy iridescence
    el(
      'linearGradient',
      { id: 'sc-of-temper', x1: '0', y1: '0', x2: '1', y2: '0.28' },
      stop('0%', '#d9b26a', 0),
      stop('34%', '#d9b26a', 0),
      stop('42%', '#d9b26a', 0.14),
      stop('48%', '#b9773f', 0.16),
      stop('54%', '#6a3f8a', 0.18),
      stop('61%', '#4f86c0', 0.2),
      stop('69%', '#4f86c0', 0),
      stop('100%', '#4f86c0', 0),
    ),
    el('radialGradient', { id: 'sc-of-hearth', cx: '96%', cy: '106%', r: '56%' }, stop('0%', '#ff5a36', 0.36), stop('36%', '#b95a2a', 0.16), stop('70%', '#222834', 0.04), stop('100%', '#131821', 0)),
    el('radialGradient', { id: 'sc-of-ember', cx: '50%', cy: '50%', r: '50%' }, stop('0%', '#fff1cf', 1), stop('42%', '#ffb347', 0.85), stop('100%', '#ff5a36', 0)),
    el('g', { id: 'sc-of-pin' }, el('circle', { r: 3.1, fill: '#080c12' }), el('circle', { cy: 0.4, r: 2.0, fill: '#6c7582' }), el('path', { d: 'm-1.1 1.2 2.2-2.2', stroke: '#1b2029', 'stroke-width': 0.9 })),
  );

  const hearth = el('rect', { class: 'sc-of-hearth', width: '100%', height: '100%', fill: 'url(#sc-of-hearth)' });
  const temper = el('rect', { class: 'sc-of-temper', x: '-65%', y: '-25%', width: '230%', height: '150%', fill: 'url(#sc-of-temper)' });

  // Chamfered alloy seam & top-left rivet
  const plateSeam = el(
    'g',
    {},
    el('path', { d: 'M2 2000V15L15 2H5000', stroke: '#060a11', 'stroke-opacity': 0.72, 'stroke-width': 3 }),
    el('path', { d: 'M4 2000V16L16 4H5000', stroke: '#adb6bd', 'stroke-opacity': 0.24, 'stroke-width': 1 }),
    el('use', { href: '#sc-of-pin', x: 8, y: 8 }),
  );

  // Starboard rivet, forged deck hatch ticks and rising sparks
  const embers: [number, number, number, string][] = [
    [-16, 88, 2.0, 'sc-of-e1'],
    [-33, 94, 1.7, 'sc-of-e2'],
    [-51, 90, 1.4, 'sc-of-e3'],
    [-24, 96, 1.5, 'sc-of-e4'],
    [-64, 95, 1.8, 'sc-of-e5'],
  ];

  const starboard = el(
    'svg',
    { x: '100%', y: '0', width: '1', height: '1', overflow: 'visible' },
    el('use', { href: '#sc-of-pin', x: -8, y: 8 }),
    // Subtle forge vent louver lines on the right steel plate
    el('path', { d: 'M-30 34h16M-26 39h12M-22 44h8', stroke: '#7d8c99', 'stroke-opacity': 0.22, 'stroke-width': 1 }),
    ...embers.map(([cx, cy, r, cls]) => el('g', { class: `sc-of-ember ${cls}` }, el('circle', { cx, cy, r: r * 2.2, fill: 'url(#sc-of-ember)', opacity: 0.6 }), el('circle', { cx, cy, r: r * 0.65, fill: '#fff6de' }))),
  );

  return rootSvg(defs, hearth, temper, plateSeam, starboard);
}

/** 6. Abyssal: undulating deep-sea caustics, bathymetric soundings, sonar ping and drifting bioluminescent motes. */
function abyssalSvg(): SVGSVGElement {
  const defs = el(
    'defs',
    {},
    el('radialGradient', { id: 'sc-ab-c1', cx: '78%', cy: '18%', r: '54%' }, stop('0%', '#2ee6d6', 0.22), stop('52%', '#146f85', 0.09), stop('100%', '#020b14', 0)),
    el('radialGradient', { id: 'sc-ab-c2', cx: '88%', cy: '86%', r: '52%' }, stop('0%', '#7a6bff', 0.24), stop('50%', '#2e3a88', 0.1), stop('100%', '#020b14', 0)),
    el('radialGradient', { id: 'sc-ab-mote-c', cx: '50%', cy: '50%', r: '50%' }, stop('0%', '#e8ffff', 1), stop('45%', '#2ee6d6', 0.78), stop('100%', '#2ee6d6', 0)),
    el('radialGradient', { id: 'sc-ab-mote-v', cx: '50%', cy: '50%', r: '50%' }, stop('0%', '#f0ecff', 1), stop('45%', '#9b86ff', 0.75), stop('100%', '#7a6bff', 0)),
    el('path', { id: 'sc-ab-shelf', d: 'M-220 14c22 10 44 16 68 10s34-24 58-20 30 26 52 25 26-16 48-15' }),
    el('path', { id: 'sc-ab-shoal', d: 'M-58 44c11-9 30-11 43-5s10 11 3 15-16 5-24 10-23 5-28-2 0-13 6-18Z' }),
  );

  // Gently drifting deep-water caustic light curtains
  const caustic1 = el('rect', { class: 'sc-ab-caustic1', x: '-16%', y: '-16%', width: '132%', height: '132%', fill: 'url(#sc-ab-c1)' });
  const caustic2 = el('rect', { class: 'sc-ab-caustic2', x: '-16%', y: '-16%', width: '132%', height: '132%', fill: 'url(#sc-ab-c2)' });

  const motes: [number, number, number, string, string][] = [
    [-22, 86, 4.0, 'sc-ab-m1', 'url(#sc-ab-mote-c)'],
    [-54, 90, 3.4, 'sc-ab-m2', 'url(#sc-ab-mote-v)'],
    [-82, 84, 3.8, 'sc-ab-m3', 'url(#sc-ab-mote-c)'],
    [-36, 94, 3.0, 'sc-ab-m4', 'url(#sc-ab-mote-c)'],
    [-108, 88, 3.2, 'sc-ab-m5', 'url(#sc-ab-mote-v)'],
    [-68, 92, 2.8, 'sc-ab-m6', 'url(#sc-ab-mote-c)'],
  ];

  // Starboard bathymetric contours, shoal rings, sonar ping and pelagic plankton
  const starboard = el(
    'svg',
    { x: '100%', y: '0', width: '1', height: '1', overflow: 'visible' },
    // Layered trench shelf contours
    el(
      'g',
      { class: 'sc-ab-contours', stroke: '#6adacb', 'stroke-opacity': 0.24, 'stroke-width': 0.8 },
      ...[undefined, 'translate(0 9) scale(1 .9)', 'translate(0 20) scale(1 .78)'].map((transform) => el('use', { href: '#sc-ab-shelf', transform })),
    ),
    // Bathymetric shoal contours
    el(
      'g',
      { stroke: '#a497ff', 'stroke-opacity': 0.3, 'stroke-width': 0.85 },
      el('use', { href: '#sc-ab-shoal' }),
      el('use', { href: '#sc-ab-shoal', transform: 'translate(-35 53) scale(.68 .66) translate(35 -53)' }),
      el('use', { href: '#sc-ab-shoal', transform: 'translate(-35 53) scale(.38 .34) translate(35 -53)' }),
    ),
    // Expanding sonar ping centered on the shoal
    el(
      'g',
      { transform: 'translate(-35 53)' },
      el('circle', { class: 'sc-ab-ping sc-ab-p1', r: 34, stroke: '#2ee6d6', 'stroke-width': 0.9 }),
      el('circle', { class: 'sc-ab-ping sc-ab-p2', r: 34, stroke: '#9b86ff', 'stroke-width': 0.75 }),
      el('circle', { class: 'sc-ab-beacon', r: 1.6, fill: '#a6fff0' }),
    ),
    // Sounding survey crosshairs
    el('path', { class: 'sc-ab-cross', d: 'M-86 24h7m-3.5-3.5v7M-16 82h6m-3-3v6', stroke: '#90f4ec', 'stroke-width': 0.85, 'stroke-opacity': 0.46 }),
    // Drifting bioluminescent motes
    ...motes.map(([cx, cy, r, cls, fill]) => el('g', { class: `sc-ab-mote ${cls}` }, el('circle', { cx, cy, r, fill, opacity: 0.72 }), el('circle', { cx, cy, r: r * 0.28, fill: '#ffffff' }))),
  );

  return rootSvg(defs, caustic1, caustic2, starboard);
}

/** 7. Astral Cathedral: vaulted chapel arches, levitating gold-tipped amethyst monolith, breathing Vesper star and nebula dust. */
function astralCathedralSvg(): SVGSVGElement {
  const defs = el(
    'defs',
    {},
    el('radialGradient', { id: 'sc-ac-mist', cx: '82%', cy: '45%', r: '56%' }, stop('0%', '#c39bff', 0.24), stop('45%', '#f0cb91', 0.1), stop('100%', '#120e1f', 0)),
    el('radialGradient', { id: 'sc-ac-halo', cx: '50%', cy: '50%', r: '50%' }, stop('0%', '#ffe8b3', 0.8), stop('48%', '#cc9fff', 0.25), stop('100%', '#cc9fff', 0)),
    el('linearGradient', { id: 'sc-ac-arch-fade', x1: '0', y1: '0', x2: '0', y2: '1' }, stop('0%', '#ffffff', 0.95), stop('62%', '#ffffff', 0.75), stop('100%', '#ffffff', 0.08)),
    el('mask', { id: 'sc-ac-mask' }, el('rect', { x: -160, y: 0, width: 170, height: 120, fill: 'url(#sc-ac-arch-fade)' })),
  );

  // Drifting nebula mist behind the chapel arches
  const mist = el('rect', { class: 'sc-ac-mist', x: '-14%', y: '-14%', width: '128%', height: '128%', fill: 'url(#sc-ac-mist)' });

  const motes: [number, number, number, string][] = [
    [-22, 86, 1.1, 'sc-ac-m1'],
    [-58, 92, 1.3, 'sc-ac-m2'],
    [-86, 84, 0.95, 'sc-ac-m3'],
    [-40, 95, 1.0, 'sc-ac-m4'],
    [-106, 90, 1.15, 'sc-ac-m5'],
  ];

  // Starboard vaulted chapel arcade with levitating monolith & Vesper star
  const arcade = el(
    'svg',
    { x: '100%', y: '0', width: '1', height: '1', overflow: 'visible' },
    el(
      'g',
      { mask: 'url(#sc-ac-mask)' },
      // Secondary faint nave arch to the left for depth
      el('path', { d: 'M-156 120V46a34 34 0 0 1 68 0v74', stroke: '#e6bd84', 'stroke-opacity': 0.14, 'stroke-width': 0.75 }),
      // Primary vaulted starboard chapel arch
      el('path', { d: 'M-82 120V44a37 37 0 0 1 74 0v76Z', fill: '#8460ac', 'fill-opacity': 0.14 }),
      el('path', { d: 'M-82 120V44a37 37 0 0 1 74 0v76M-78 120V44a33 33 0 0 1 66 0v76', stroke: '#e6bd84', 'stroke-opacity': 0.36, 'stroke-width': 0.8 }),
      el('path', { d: 'M-74 120V60c0-18 13-23 29-37 16 14 29 19 29 37v60', stroke: '#e6bd84', 'stroke-opacity': 0.22, 'stroke-width': 0.75 }),
      el('path', { d: 'M-45 10v9m0 6v8', stroke: '#e6bd84', 'stroke-opacity': 0.38, 'stroke-width': 0.8 }),
    ),
    // Levitating amethyst-and-gold monolith inside the chapel arch
    el(
      'g',
      { class: 'sc-ac-monolith' },
      el('circle', { class: 'sc-ac-aureole', cx: -45, cy: 52, r: 15, fill: 'url(#sc-ac-halo)', opacity: 0.34 }),
      el('path', { d: 'm-45 36 4.5 3.4v15.6l-4.5 3.4-4.5-3.4V39.4Z', fill: '#b784d8', 'fill-opacity': 0.34, stroke: '#e6bd84', 'stroke-opacity': 0.32, 'stroke-width': 0.6 }),
      el('path', { d: 'm-45 36 4.5 3.4v15.6l-4.5 3.4Z', fill: '#371c4e', 'fill-opacity': 0.82 }),
      el('path', { d: 'm-49.5 55 4.5-2.2 4.5 2.2-4.5 3.4Z', fill: '#f0cb91', 'fill-opacity': 0.82 }),
    ),
    // Breathing four-point Vesper star beneath the monolith
    el('g', { transform: 'translate(-45 73)' }, el('path', { class: 'sc-ac-star', d: 'M0-7 1.3-1.3 7 0 1.3 1.3 0 7 -1.3 1.3 -7 0 -1.3-1.3Z', fill: '#fff0cd' })),
    // Quiet companion star in the secondary arch
    el('g', { transform: 'translate(-122 36)' }, el('path', { class: 'sc-ac-star2', d: 'M0-3.5 .7-.7 3.5 0 .7 .7 0 3.5 -.7 .7 -3.5 0 -.7-.7Z', fill: '#f0cb91', opacity: 0.55 })),
    // Ascending celestial dust motes
    ...motes.map(([cx, cy, r, cls]) => el('circle', { class: `sc-ac-mote ${cls}`, cx, cy, r, fill: '#ffe8b8' })),
  );

  return rootSvg(defs, mist, arcade);
}

/** 8. Sakura Mist: swaying cherry blossom bough, warm dusk mist and drifting notched sakura petals. */
function sakuraMistSvg(): SVGSVGElement {
  const defs = el(
    'defs',
    {},
    el('radialGradient', { id: 'sc-sm-mist', cx: '88%', cy: '26%', r: '56%' }, stop('0%', '#ffd1e0', 0.2), stop('44%', '#ca86a3', 0.12), stop('100%', '#22161e', 0)),
    el('path', { id: 'sc-sm-petal', d: 'M0 0C-1.9-1.5-4.3-5-2.4-7.4Q-1.3-8.6 0-6.9Q1.4-8.6 2.5-7.3C4.5-5.1 1.9-1.4 0 0Z' }),
    el('g', { id: 'sc-sm-flower' }, ...[0, 72, 144, 216, 288].map((deg) => el('use', { href: '#sc-sm-petal', transform: deg ? `rotate(${deg})` : undefined })), el('circle', { r: 1.25, fill: '#ffe4c4' })),
  );

  // Soft dusk rose-gold mist behind the blossoms
  const mist = el('rect', { class: 'sc-sm-mist', x: '-14%', y: '-14%', width: '128%', height: '128%', fill: 'url(#sc-sm-mist)' });

  // Drifting notched cherry petals
  const drifting: [number, number, number, string, string][] = [
    [-26, 22, 0.82, 'sc-sm-p1', '#f8bbcf'],
    [-58, 16, 0.72, 'sc-sm-p2', '#ffe4d8'],
    [-86, 28, 0.68, 'sc-sm-p3', '#edb4c7'],
    [-40, 38, 0.78, 'sc-sm-p4', '#ffe4d8'],
    [-108, 14, 0.62, 'sc-sm-p5', '#f8bbcf'],
    [-16, 42, 0.7, 'sc-sm-p6', '#d88eaa'],
  ];

  // Starboard cherry blossom sprig anchored to upper-right corner + drifting petals
  const canopy = el(
    'svg',
    { x: '100%', y: '0', width: '1', height: '1', overflow: 'visible' },
    // Swaying cherry bough anchored cleanly at (0, 0) = top-right edge
    el(
      'g',
      { class: 'sc-sm-bough', opacity: 0.78 },
      el('path', { fill: '#c493a1', d: 'M4 1C-13 2-23 18-42 20C-64 22-78 14-106 23C-83 12-66 17-48 17C-32 17-19 5-9-2Z' }),
      el('path', { fill: 'none', stroke: '#c493a1', 'stroke-linecap': 'round', 'stroke-width': 1.05, d: 'M-28 15Q-37 29-56 38M-42 20Q-48 12-58 9M-71 18Q-80 23-85 29M-89 18Q-99 13-112 15M-16 8Q-17 23-28 27' }),
      el(
        'g',
        { fill: '#f2bed0' },
        el('use', { href: '#sc-sm-flower', transform: 'translate(-48 16) rotate(24) scale(1.06)' }),
        el('use', { href: '#sc-sm-flower', transform: 'translate(-79 23) rotate(-11) scale(.72)' }),
        el('use', { href: '#sc-sm-flower', transform: 'translate(-31 29) rotate(19) scale(.84)' }),
        el('use', { href: '#sc-sm-flower', transform: 'translate(-17 5) rotate(-14) scale(.78)' }),
      ),
      el(
        'g',
        { fill: '#da94b0' },
        el('use', { href: '#sc-sm-petal', transform: 'translate(-54 38) rotate(-115) scale(.84)' }),
        el('use', { href: '#sc-sm-petal', transform: 'translate(-58 9) rotate(-47) scale(.82)' }),
        el('use', { href: '#sc-sm-petal', transform: 'translate(-105 18) rotate(-104) scale(.76)' }),
      ),
    ),
    // Drifting breeze petals
    ...drifting.map(([x, y, s, cls, fill]) => el('g', { class: `sc-sm-petal ${cls}` }, el('use', { href: '#sc-sm-petal', fill, transform: `translate(${x} ${y}) scale(${s})` }))),
  );

  return rootSvg(defs, mist, canopy);
}

/** One bespoke side-nav card builder per animated companion theme. */
export const SIDE_CARD_BUILDERS: Readonly<Partial<Record<CompanionThemeId, () => SVGSVGElement>>> = {
  'carbons-copy': carbonsCopySvg,
  'nightly-orbit': nightlyOrbitSvg,
  'neo-tokyo': neoTokyoSvg,
  'kyoto-firefly': kyotoFireflySvg,
  'orbital-foundry': orbitalFoundrySvg,
  'abyssal-biolume': abyssalSvg,
  'astral-cathedral': astralCathedralSvg,
  'sakura-mist': sakuraMistSvg,
};

/** The theme IDs that ship with an animated sidebar nameplate layer. */
export const SIDE_CARD_THEME_IDS: readonly CompanionThemeId[] = Object.keys(SIDE_CARD_BUILDERS) as CompanionThemeId[];

/** Mounts, updates or removes the animated `.dash-side-fx` artwork inside `.dash-side-head`. */
export function renderSideCardFx(host: HTMLElement, theme: Pick<CompanionTheme, 'id' | 'backdrop'>): void {
  const existing = host.querySelector<HTMLElement>(':scope > .dash-side-fx');
  const build = theme.backdrop.stage ? SIDE_CARD_BUILDERS[theme.id as CompanionThemeId] : undefined;
  if (!build) {
    existing?.remove();
    return;
  }
  if (existing?.dataset.card === theme.id) return;
  const fx = document.createElement('div');
  fx.className = 'dash-side-fx';
  fx.dataset.card = theme.id;
  fx.setAttribute('aria-hidden', 'true');
  const edge = document.createElement('span');
  edge.className = 'dash-side-fx-edge';
  fx.append(build(), edge);
  if (existing) existing.replaceWith(fx);
  else host.prepend(fx);
}
