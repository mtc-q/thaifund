// Parameter schema shared by the UI, the state store and the GPU shaders.
// The order of GLOBAL_PARAMS / LOCAL_PARAMS defines the uniform array layout.

const P = (id, label, min, max, def = 0, o = {}) => ({ id, label, min, max, def, step: 1, scale: 0.01, ...o });
const EV = { step: 0.01, scale: 1, fmt: v => (v > 0 ? '+' : '') + v.toFixed(2) };
const HUE = { scale: 1, track: 'hue', fmt: v => Math.round(v) + '°' };

export const GLOBAL_PARAMS = [
  // Light
  P('exposure', 'Exposure', -4, 4, 0, { ...EV, track: 'exp' }),
  P('brilliance', 'Brilliance', -100, 100),
  P('highlights', 'Highlights', -100, 100),
  P('shadows', 'Shadows', -100, 100),
  P('brightness', 'Brightness', -100, 100),
  P('contrast', 'Contrast', -100, 100),
  P('blackPoint', 'Black Point', -100, 100),
  P('whites', 'Whites', -100, 100),
  // Color
  P('saturation', 'Saturation', -100, 100, 0, { track: 'sat' }),
  P('vibrance', 'Vibrance', -100, 100),
  P('warmth', 'Warmth', -100, 100, 0, { track: 'temp' }),
  P('tint', 'Tint', -100, 100, 0, { track: 'tint' }),
  // Black & white
  P('bwIntensity', 'Intensity', 0, 100),
  P('bwNeutrals', 'Neutrals', -100, 100),
  P('bwTone', 'Tone', -100, 100),
  P('bwGrain', 'Grain', 0, 100),
  // Levels (0..255 UI)
  P('lvInBlack', 'Input Black', 0, 250, 0, { scale: 1 / 255, track: 'mono' }),
  P('lvInWhite', 'Input White', 5, 255, 255, { scale: 1 / 255, track: 'mono' }),
  P('lvGamma', 'Midtones', 0.1, 5, 1, { step: 0.01, scale: 1, fmt: v => v.toFixed(2) }),
  P('lvOutBlack', 'Output Black', 0, 255, 0, { scale: 1 / 255, track: 'mono' }),
  P('lvOutWhite', 'Output White', 0, 255, 255, { scale: 1 / 255, track: 'mono' }),
  // Color grading
  P('gsHue', 'Shadows Hue', 0, 360, 215, HUE),
  P('gsSat', 'Shadows Amount', 0, 100),
  P('gmHue', 'Midtones Hue', 0, 360, 40, HUE),
  P('gmSat', 'Midtones Amount', 0, 100),
  P('ghHue', 'Highlights Hue', 0, 360, 45, HUE),
  P('ghSat', 'Highlights Amount', 0, 100),
  P('gBalance', 'Balance', -100, 100),
  // Detail
  P('sharpness', 'Sharpness', 0, 100),
  P('sharpRadius', 'Radius', 0.5, 3, 1, { step: 0.1, scale: 1, fmt: v => v.toFixed(1) + ' px' }),
  P('definition', 'Definition', -100, 100),
  P('noise', 'Noise Reduction', 0, 100),
  P('colorNoise', 'Color Noise', 0, 100),
  // Effects
  P('dehaze', 'Dehaze', -100, 100),
  P('glow', 'Glow', 0, 100),
  P('fade', 'Fade', 0, 100),
  P('grain', 'Grain', 0, 100),
  P('grainSize', 'Grain Size', 0, 100, 30),
  // Vignette
  P('vigAmount', 'Strength', -100, 100),
  P('vigRadius', 'Radius', 0, 100, 55),
  P('vigSoftness', 'Softness', 0, 100, 55),
  P('vigRoundness', 'Roundness', 0, 100, 40),
];

export const PARAM = Object.fromEntries(GLOBAL_PARAMS.map((p, i) => [p.id, { ...p, index: i }]));
export const HUE_PARAMS = new Set(['gsHue', 'gmHue', 'ghHue']);

export const SECTIONS = [
  { id: 'light', title: 'Light', icon: 'i-sun', master: true, auto: true,
    params: ['exposure', 'brilliance', 'highlights', 'shadows', 'brightness', 'contrast', 'blackPoint', 'whites'] },
  { id: 'color', title: 'Color', icon: 'i-drop', master: true, auto: true, picker: true,
    params: ['saturation', 'vibrance', 'warmth', 'tint'] },
  { id: 'bw', title: 'Black & White', icon: 'i-contrast', master: true,
    params: ['bwIntensity', 'bwNeutrals', 'bwTone', 'bwGrain'] },
  { id: 'hsl', title: 'Selective Color', icon: 'i-hsl', custom: 'hsl', params: [] },
  { id: 'curves', title: 'Curves', icon: 'i-curve', custom: 'curves', params: [] },
  { id: 'levels', title: 'Levels', icon: 'i-levels', auto: true,
    params: ['lvInBlack', 'lvInWhite', 'lvGamma', 'lvOutBlack', 'lvOutWhite'] },
  { id: 'grading', title: 'Color Grading', icon: 'i-wheel', custom: 'grading',
    params: ['gsHue', 'gsSat', 'gmHue', 'gmSat', 'ghHue', 'ghSat', 'gBalance'] },
  { id: 'detail', title: 'Detail', icon: 'i-aperture',
    params: ['sharpness', 'sharpRadius', 'definition', 'noise', 'colorNoise'] },
  { id: 'effects', title: 'Effects', icon: 'i-fx',
    params: ['dehaze', 'glow', 'fade', 'grain', 'grainSize'] },
  { id: 'vignette', title: 'Vignette', icon: 'i-vignette',
    params: ['vigAmount', 'vigRadius', 'vigSoftness', 'vigRoundness'] },
];

// Parameters that only matter when another parameter is active.
export const DEPENDENT = {
  sharpRadius: 'sharpness', grainSize: 'grain',
  vigRadius: 'vigAmount', vigSoftness: 'vigAmount', vigRoundness: 'vigAmount',
  gsHue: 'gsSat', gmHue: 'gmSat', ghHue: 'ghSat',
};

// Local adjustments applied to the subject or to the background (deltas on top of global).
export const LOCAL_PARAMS = [
  P('exposure', 'Exposure', -3, 3, 0, EV),
  P('brightness', 'Brightness', -100, 100),
  P('contrast', 'Contrast', -100, 100),
  P('highlights', 'Highlights', -100, 100),
  P('shadows', 'Shadows', -100, 100),
  P('saturation', 'Saturation', -100, 100, 0, { track: 'sat' }),
  P('vibrance', 'Vibrance', -100, 100),
  P('warmth', 'Warmth', -100, 100, 0, { track: 'temp' }),
  P('tint', 'Tint', -100, 100, 0, { track: 'tint' }),
  P('definition', 'Definition', -100, 100),
  P('sharpness', 'Sharpness', 0, 100),
  P('glow', 'Glow', 0, 100),
];
export const BG_PARAMS = [
  P('blur', 'Lens Blur', 0, 100),
  P('bokeh', 'Bokeh Highlights', 0, 100),
];

export const HSL_BANDS = [
  { id: 'red', label: 'Red', color: '#f0443a' },
  { id: 'orange', label: 'Orange', color: '#f5902c' },
  { id: 'yellow', label: 'Yellow', color: '#f2d12e' },
  { id: 'green', label: 'Green', color: '#3fc04f' },
  { id: 'aqua', label: 'Aqua', color: '#2ccdd0' },
  { id: 'blue', label: 'Blue', color: '#3a6ff2' },
  { id: 'purple', label: 'Purple', color: '#8e4ef0' },
  { id: 'magenta', label: 'Magenta', color: '#e443c2' },
];

// Master "smart" sliders: t in [-1, 1] → sub-parameter values.
export const MASTERS = {
  light(t) {
    if (t >= 0) return { exposure: +(0.75 * t).toFixed(2), brilliance: 30 * t, highlights: -32 * t, shadows: 34 * t, brightness: 10 * t, contrast: 4 * t, blackPoint: 4 * t };
    const u = -t;
    return { exposure: +(-0.9 * u).toFixed(2), brilliance: -12 * u, highlights: 12 * u, shadows: -22 * u, brightness: -14 * u, contrast: 14 * u, blackPoint: 8 * u };
  },
  color(t) {
    if (t >= 0) return { saturation: 32 * t, vibrance: 40 * t };
    return { saturation: 100 * t, vibrance: 15 * t };
  },
  bw(t) {
    return { bwIntensity: 100, bwTone: 55 * t, bwNeutrals: 25 * t, bwGrain: 0 };
  },
};

export const ASPECTS = [
  { id: 'free', label: 'Free', r: 0 },
  { id: 'original', label: 'Original', r: -1 },
  { id: '1:1', label: '1:1', r: 1 },
  { id: '4:5', label: '4:5', r: 4 / 5 },
  { id: '3:2', label: '3:2', r: 3 / 2 },
  { id: '4:3', label: '4:3', r: 4 / 3 },
  { id: '5:4', label: '5:4', r: 5 / 4 },
  { id: '7:5', label: '7:5', r: 7 / 5 },
  { id: '16:9', label: '16:9', r: 16 / 9 },
  { id: '16:10', label: '16:10', r: 16 / 10 },
  { id: '21:9', label: '21:9', r: 21 / 9 },
  { id: '2:1', label: '2:1', r: 2 },
  { id: '1.91:1', label: '1.91:1', r: 1.91 },
  { id: '3:1', label: '3:1', r: 3 },
  { id: 'iso', label: 'A4 √2', r: Math.SQRT2 },
  { id: 'custom', label: 'Custom', r: -2 },
];

export const OVERLAYS = [
  { id: 'thirds', label: 'Thirds' },
  { id: 'golden', label: 'Phi grid' },
  { id: 'spiral', label: 'Spiral' },
  { id: 'diagonal', label: 'Diagonal' },
  { id: 'triangle', label: 'Triangle' },
  { id: 'grid', label: 'Grid' },
  { id: 'center', label: 'Center' },
  { id: 'none', label: 'None' },
];

// Built-in looks. Values are deltas (in UI units) added on top of the user's settings,
// scaled by the look intensity. Hue values are absolute.
export const LOOKS = [
  { id: 'none', name: 'Original', p: {} },
  { id: 'vivid', name: 'Vivid', p: { contrast: 12, vibrance: 28, saturation: 12, shadows: 10, highlights: -12, definition: 10 } },
  { id: 'vivid-warm', name: 'Vivid Warm', p: { contrast: 12, vibrance: 24, saturation: 10, shadows: 10, highlights: -12, warmth: 22, tint: 4 } },
  { id: 'vivid-cool', name: 'Vivid Cool', p: { contrast: 12, vibrance: 24, saturation: 10, shadows: 10, highlights: -12, warmth: -22, tint: -3 } },
  { id: 'dramatic', name: 'Dramatic', p: { contrast: 28, highlights: -45, shadows: -8, definition: 32, saturation: -18, vigAmount: 22, brilliance: -10 } },
  { id: 'dramatic-warm', name: 'Drama Warm', p: { contrast: 26, highlights: -40, definition: 28, saturation: -12, warmth: 24, vigAmount: 20 } },
  { id: 'dramatic-cool', name: 'Drama Cool', p: { contrast: 26, highlights: -40, definition: 28, saturation: -16, warmth: -24, vigAmount: 20 } },
  { id: 'golden', name: 'Golden Hour', p: { warmth: 30, tint: 6, glow: 18, highlights: -15, shadows: 14, ghHue: 40, ghSat: 22, vibrance: 10 } },
  { id: 'teal-orange', name: 'Teal & Orange', p: { gsHue: 192, gsSat: 42, ghHue: 32, ghSat: 32, contrast: 12, vibrance: 8, saturation: -6 } },
  { id: 'cinematic', name: 'Cinematic', p: { contrast: 16, gsHue: 205, gsSat: 30, ghHue: 38, ghSat: 18, fade: 10, saturation: -12, vigAmount: 18, highlights: -20 } },
  { id: 'film', name: 'Film 70', p: { fade: 22, warmth: 14, gmHue: 50, gmSat: 12, gsHue: 175, gsSat: 18, grain: 28, saturation: -10, contrast: 6 } },
  { id: 'matte', name: 'Matte', p: { fade: 38, contrast: -8, saturation: -10, highlights: -10 } },
  { id: 'pastel', name: 'Pastel', p: { brightness: 18, contrast: -22, saturation: -18, vibrance: 10, fade: 20, highlights: -10, ghHue: 330, ghSat: 12 } },
  { id: 'nordic', name: 'Nordic', p: { warmth: -16, saturation: -32, fade: 16, brightness: 8, contrast: -6, highlights: -10 } },
  { id: 'punch', name: 'Punch', p: { contrast: 30, vibrance: 35, definition: 22, blackPoint: 12, brilliance: 15 } },
  { id: 'soft', name: 'Soft Skin', p: { glow: 22, contrast: -10, highlights: -12, warmth: 8, definition: -18, vibrance: 6 } },
  { id: 'mono', name: 'Mono', p: { bwIntensity: 100 } },
  { id: 'silver', name: 'Silver', p: { bwIntensity: 100, bwTone: 18, bwNeutrals: 12, highlights: -12, shadows: 10 } },
  { id: 'noir', name: 'Noir', p: { bwIntensity: 100, bwTone: 60, contrast: 26, vigAmount: 35, bwGrain: 22, blackPoint: 10 } },
  { id: 'sepia', name: 'Sepia', p: { bwIntensity: 100, gsHue: 28, gsSat: 38, gmHue: 34, gmSat: 30, ghHue: 44, ghSat: 22, fade: 10 } },
  { id: 'cyanotype', name: 'Cyanotype', p: { bwIntensity: 100, gsHue: 212, gsSat: 60, gmHue: 205, gmSat: 40, ghHue: 200, ghSat: 12 } },
];

// One-click subject / background presets.
export const SUBJECT_FX = [
  { id: 'portrait', name: 'Portrait', desc: 'Soft lens blur behind them', bg: { blur: 55, bokeh: 25 }, subj: { definition: 8 }, mode: 'keep' },
  { id: 'studio', name: 'Studio', desc: 'Darker, quieter backdrop', bg: { blur: 35, exposure: -0.6, saturation: -30 }, subj: { exposure: 0.15, definition: 15, vibrance: 10 }, mode: 'keep' },
  { id: 'colorpop', name: 'Colour pop', desc: 'Background turns black & white', bg: { saturation: -100 }, subj: { vibrance: 20 }, mode: 'keep' },
  { id: 'spotlight', name: 'Spotlight', desc: 'Dims everything else', bg: { exposure: -1.3, blur: 18 }, subj: { exposure: 0.1 }, mode: 'keep' },
  { id: 'stage', name: 'Black backdrop', desc: 'Solid black behind the subject', bg: {}, subj: { contrast: 8 }, mode: 'color', color: '#000000' },
  { id: 'highkey', name: 'White backdrop', desc: 'Clean white, like a catalogue shot', bg: {}, subj: { brightness: 8 }, mode: 'color', color: '#ffffff' },
  { id: 'dreamy', name: 'Dreamy', desc: 'Heavy blur and a soft glow', bg: { blur: 70, bokeh: 60, glow: 40, exposure: 0.2 }, subj: { glow: 12 }, mode: 'keep' },
  { id: 'cutout', name: 'Cut out', desc: 'Transparent background, for PNG', bg: {}, subj: {}, mode: 'transparent' },
];

export function defaultParams() {
  return Object.fromEntries(GLOBAL_PARAMS.map(p => [p.id, p.def]));
}
export function defaultLocal(withBg) {
  const o = Object.fromEntries(LOCAL_PARAMS.map(p => [p.id, p.def]));
  if (withBg) for (const p of BG_PARAMS) o[p.id] = p.def;
  return o;
}
export function defaultCurves() {
  return { rgb: [[0, 0], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] };
}
export function defaultGeo(Wo, Ho) {
  return { rot: 0, flipH: false, flipV: false, angle: 0, perspV: 0, perspH: 0, crop: { x: -Wo / 2, y: -Ho / 2, w: Wo, h: Ho }, aspect: 'free', portrait: false, custom: [4, 3] };
}
export function defaultState(W = 1, H = 1) {
  return {
    p: defaultParams(),
    hsl: { h: Array(8).fill(0), s: Array(8).fill(0), l: Array(8).fill(0) },
    curves: defaultCurves(),
    masters: { light: 0, color: 0, bw: 0 },
    bypass: {},
    look: { id: 'none', amount: 100 },
    local: { subject: defaultLocal(false), background: defaultLocal(true) },
    bg: { mode: 'keep', color: '#ffffff' },
    mask: { on: {}, feather: 0, shift: 0, invert: false },
    geo: defaultGeo(W, H),
  };
}
