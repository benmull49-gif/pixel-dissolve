# Pixel Dissolve

Renders a 3D model (procedural flower, uploaded OBJ, or uploaded GLB), an image, or a video as a
stylized brightness-driven halftone dot-matrix effect, with an optional color-dispersion glitch,
PNG (alpha) export, video recording, and an alpha-channel frame-sequence export (numbered PNGs
bundled into a ZIP via [JSZip](https://stuk.github.io/jszip/)).

Built with [Next.js](https://nextjs.org) and [shadcn/ui](https://ui.shadcn.com). The rendering
engine (`src/components/pixel-dissolve/engine.ts`) is a near-verbatim port of an earlier vanilla
canvas/WebGL build — it owns the two canvases and most form controls directly by DOM id; the
React layer (`PixelDissolve.tsx`) renders the shadcn-based UI shell and pushes slider/select/
switch changes into the engine through a small set of setter functions.

## Run locally

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Deploy

Push to GitHub and import the repo in [Vercel](https://vercel.com/new) — it's a standard Next.js
app, so the default framework preset and build settings apply with no extra configuration.
