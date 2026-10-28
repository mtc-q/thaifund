# Thaifund

**A private, professional photo editor that runs entirely in your browser.**
Open a photo, adjust the light and colour, select people or objects with on-device AI, blur or replace the background, crop, and export to 16 formats. Nothing is uploaded: there is no server.

---

## Publish it on GitHub Pages

1. Create a new repository on GitHub (for example `thaifund`).
2. Upload **the contents of this folder** to the root of the repository (drag the files and folders into GitHub's *Add file → Upload files* page, or use `git push`).
3. In the repository, open **Settings → Pages**.
4. Under *Build and deployment*, choose **Deploy from a branch**, select `main` and the `/ (root)` folder, then click **Save**.
5. After a minute your editor is live at `https://<your-username>.github.io/<repository-name>/`.

All paths are relative, so the site works from a project sub-path or a custom domain without changes. There is no build step.

> Opening `index.html` directly from disk (`file://`) won't work, because browsers block JavaScript modules there. To try it locally, serve the folder with any static server, for example `npx serve .` or `python -m http.server`, and open the printed address.

---

## Features

### Adjust (inspired by the built-in Photos editor, with pro additions)
- **Light**: Exposure, Brilliance, Highlights, Shadows, Brightness, Contrast, Black Point, Whites, plus a filmstrip **master slider** that moves them all together.
- **Color**: Saturation, Vibrance (skin-tone protected), Warmth, Tint, a master slider, auto white balance and a **white-balance eyedropper**.
- **Black & White**: Intensity, Neutrals, Tone, Grain.
- **Selective Color**: hue / saturation / luminance for 8 colour ranges.
- **Curves**: RGB + per-channel tone curves over a histogram.
- **Levels**: input/output black and white points and midtones, with an auto button.
- **Color Grading**: shadow / midtone / highlight colour wheels with balance.
- **Detail**: Sharpness (with radius), Definition (local contrast), luminance and colour noise reduction.
- **Effects**: Dehaze, Glow, Fade, film Grain.
- **Vignette**: strength, radius, softness, roundness.
- **Auto Enhance**, per-section on/off toggles, reset per section, live histogram with clipping indicators.

### Subject: AI selection running on your device
- **Select Subject** detects people and 20 object classes (cars, dogs, cats, birds, horses, bikes…) and separates individuals ("Person 1", "Person 2").
- People are refined with a dedicated portrait model; all edges are snapped to the photo with an edge-aware guided filter.
- **Tap to add**: click anything in the photo to select it, or Alt+click to remove an area.
- **Refine brush** with *Smart edges* (paints only similar colours), hardness, flow, feather and shift-edge.
- **Background**: lens blur with bokeh highlights (no halos around the subject), or transparent, or a solid colour, plus its own light and colour sliders.
- **Subject**: its own exposure, contrast, colour, definition, sharpness and glow.
- One-click **Portrait Effects**: Portrait Blur, Studio, Color Pop, Spotlight, Stage Black, High-Key, Dreamy, Remove BG.

### Crop & geometry
- Free or locked aspect ratios (1:1, 4:5, 3:2, 4:3, 5:4, 7:5, 16:9, 16:10, 21:9, 2:1, 1.91:1, 3:1, A-series √2, custom), with portrait / landscape swap.
- Straighten dial (±45°), **auto straighten** (horizon detection), and drag outside the crop box to rotate.
- **Perspective correction** (vertical and horizontal keystone).
- Rotate 90°, flip horizontal / vertical.
- The crop always stays inside the image after rotation or perspective changes.
- Composition overlays: thirds, phi grid, golden spiral, diagonal, triangle, grid, centre.
- Exact pixel size entry.

### Looks & presets
- 20 built-in looks with live thumbnails and an intensity slider (0–200 %).
- Save your own presets (stored in the browser), import / export them as JSON.
- Copy settings from one photo and paste them onto another.

### Export
- **Formats**: JPEG, PNG, WebP, AVIF*, TIFF (ZIP or uncompressed), PSD, BMP, GIF (adaptive palette + dithering), ICO (multi-size), TGA, DDS, QOI, PPM, PDF, SVG, Radiance HDR.
- **Resolution**: original, long-edge presets, percentage or exact pixels (up to about 268 MP); Lanczos-3, bicubic or nearest-neighbour resampling; output sharpening.
- **DPI** written to JPEG, PNG, TIFF, BMP, PSD and PDF.
- Export the **subject cut-out** (transparent PNG and similar) or the **subject mask**.
- Full-resolution rendering in GPU tiles, so very large photos export without seams.
- EXIF / GPS metadata is never copied into exports.
- Copy the result to the clipboard.

\* AVIF export appears when the browser can encode it.

### Workflow
- Unlimited undo / redo with a history panel, hold `\` for before / after, split view, clipping warnings, pixel readout, zoom from 1 % to 3200 %, pinch zoom on touch screens.
- Opens anything the browser can decode (JPEG, PNG, WebP, AVIF, GIF, BMP, SVG, ICO…) **plus TIFF, PSD, TGA, QOI and PNM** through built-in decoders. EXIF orientation is respected. Paste images with Ctrl+V or drag and drop.
- Works offline after the first visit (service worker) and can be installed as an app.

Press `?` in the app for all keyboard shortcuts.

---

## How it works

| Part | Technique |
|---|---|
| Rendering | WebGL 2 with 16-bit float buffers. Every adjustment is a GPU shader, so sliders update in real time. Exposure, white balance and blur work in linear light; tone and colour work in perceptual space. |
| Local adjustments | Shadows, highlights, brilliance, definition and dehaze use multi-scale blurred "context" images computed once per frame and cached. |
| Lens blur | Golden-angle disc sampling on a mask-weighted image pyramid, so subject pixels never bleed into the blurred background. |
| AI selection | [MediaPipe Tasks](https://ai.google.dev/edge/mediapipe) (WebAssembly) running DeepLab-v3 (objects), Selfie Multiclass (people) and MagicTouch (tap-to-select). The runtime and models (about 35 MB in total) download once, only when you first use subject selection, and are then cached. Your photo is processed on your device. |
| Edge refinement | Colour guided filter (He et al.) at two scales, connected-component analysis to separate subjects. |
| Export | Encoders written in JavaScript for TIFF, PSD, BMP, GIF (median-cut + LZW), ICO, TGA, DDS, QOI, PPM, PDF, SVG and HDR; native browser encoders for JPEG, PNG, WebP and AVIF. |

## Requirements

A current version of Chrome, Edge, Firefox or Safari with WebGL 2 and hardware acceleration enabled. HEIC photos can only be opened in Safari (other browsers cannot decode them).

## Project layout

```
index.html              app shell and icon sprite
css/app.css             UI styles
fonts/                  IBM Plex Sans / Mono, Instrument Serif (OFL)
js/main.js              bootstrap, tabs, tools, keyboard shortcuts
js/app.js               document, view, render loop, histogram
js/engine/              WebGL renderer and GLSL shaders
js/panels/              Adjust, Subject, Crop, Looks and Export panels
js/ai/                  MediaPipe loader and mask refinement
js/export/              encoders, decoders and resampling
js/schema.js            every slider, look and preset in one place
sw.js                   offline cache
```

## Third-party components

The AI runtime (`@mediapipe/tasks-vision`) and its models are © Google, Apache License 2.0, loaded at runtime from jsDelivr and Google Cloud Storage. The interface fonts, IBM Plex Sans, IBM Plex Mono and Instrument Serif, are bundled in `fonts/` under the SIL Open Font License 1.1. No other libraries are used.
