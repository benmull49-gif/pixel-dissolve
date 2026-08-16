# Pixel Dissolve

Browser-based WebGL/Canvas2D tool that renders a 3D model (procedural flower, uploaded OBJ, or uploaded GLB) as a stylized brightness-driven halftone dot-matrix effect, with an optional color-dispersion glitch effect, PNG (alpha) export, video recording, and an alpha-channel frame-sequence export (numbered PNGs bundled into a ZIP via [JSZip](https://stuk.github.io/jszip/)).

No build step — `index.html` is a single self-contained static page (JSZip is loaded from a CDN).

## Run locally

Just open `index.html` in a browser, or serve the folder with any static file server, e.g.:

```
npx serve .
```

## Deploy

Push to GitHub and import the repo in [Vercel](https://vercel.com/new) — no build command or output directory needed (it's a static site).
