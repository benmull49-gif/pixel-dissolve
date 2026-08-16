'use client';

import { useEffect, useRef, useState } from 'react';
import { initPixelDissolveEngine, type PixelDissolveEngine } from './engine';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

// The engine wires up global listeners and starts its own render loop with no teardown, so it
// must boot exactly once per page load. React StrictMode double-invokes effects in dev, so a
// module-scope guard (not component state) is what actually prevents a second boot.
let engineBooted = false;

function GroupCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="font-mono text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

function FieldSlider({
  label,
  value,
  display,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="field-row">
        <span>{label}</span>
        <span>{display}</span>
      </div>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(v) => onChange(Array.isArray(v) ? v[0] : v)}
      />
    </div>
  );
}

function ColorSwatch({ id, defaultValue, label }: { id: string; defaultValue: string; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1">
      <input type="color" id={id} defaultValue={defaultValue} />
      <label htmlFor={id} className="font-mono text-[8.5px] text-muted-foreground">
        {label}
      </label>
    </div>
  );
}

// Collapsed by default — explanatory copy takes real vertical space across a dozen-plus
// control groups, and most of it only matters the first time you're wondering what a
// control does.
function HintDetails({ summary, children }: { summary: string; children: React.ReactNode }) {
  return (
    <details className="hint">
      <summary className="cursor-pointer select-none">{summary}</summary>
      <div className="mt-1.5">{children}</div>
    </details>
  );
}

export default function PixelDissolve() {
  const engineRef = useRef<PixelDissolveEngine | null>(null);

  const [lightIntensity, setLightIntensity] = useState(1.15);
  const [lightContrast, setLightContrast] = useState(0.85);
  const [exportScale, setExportScale] = useState(3);
  const [frameSeqDur, setFrameSeqDur] = useState(4.0);
  const [frameSeqFps, setFrameSeqFps] = useState(24);
  const [cellSize, setCellSize] = useState(130);
  const [dotScale, setDotScale] = useState(1.05);
  const [dotGamma, setDotGamma] = useState(0.85);
  const [dotShape, setDotShape] = useState('circle');
  const [dissolve, setDissolve] = useState(0.22);
  const [edgeRand, setEdgeRand] = useState(0.35);
  const [glowAmt, setGlowAmt] = useState(0.6);
  const [glowSize, setGlowSize] = useState(1.0);
  const [glitchEnabled, setGlitchEnabled] = useState(false);
  const [glitchFreq, setGlitchFreq] = useState(0.5);
  const [glitchIntensity, setGlitchIntensity] = useState(10);
  const [glitchDuration, setGlitchDuration] = useState(130);
  const [glitchAsciiSize, setGlitchAsciiSize] = useState(0.45);
  const [dustAmt, setDustAmt] = useState(0.3);
  const [asciiAmt, setAsciiAmt] = useState(0.25);
  const [asciiSize, setAsciiSize] = useState(1.0);
  const [accentAmt, setAccentAmt] = useState(0.3);

  useEffect(() => {
    if (engineBooted) return;
    engineBooted = true;
    engineRef.current = initPixelDissolveEngine();
  }, []);

  const exportPixels = `${700 * exportScale}×${700 * exportScale}`;

  return (
    // Fixed to the viewport height only from `lg` up, where the two-column layout applies and
    // the sidebar needs its own internal scrollbar. Below that, the page just scrolls normally —
    // critical so the control cards are never clipped with no way to reach them on a narrower
    // window/screen, which a plain `overflow-hidden` at every breakpoint used to do.
    <div className="flex min-h-screen flex-col bg-background text-foreground lg:h-screen lg:overflow-hidden">
      <header className="flex flex-wrap items-baseline justify-between gap-4 border-b border-border px-6 py-4">
        <div className="flex items-baseline gap-3">
          <h1 className="font-mono text-[15px] font-semibold tracking-wide">PIXEL DISSOLVE</h1>
          <Badge variant="secondary" className="font-mono text-[10px] uppercase tracking-wider">
            prototype
          </Badge>
        </div>
        <div id="statusText" className="font-mono text-[11px] text-muted-foreground">
          rendering
        </div>
      </header>

      <main className="flex min-h-0 flex-1 flex-col gap-4 p-4 lg:flex-row">
        {/* Left: viewports. Each is a single tile (no header bar above it) with the caption
            overlaid on the canvas itself, both forced to the same rendered size via
            object-contain regardless of their differing internal resolutions (560 vs 700),
            and stretched to fill all the height available below the header. */}
        <div className="grid min-h-[320px] flex-1 grid-cols-1 gap-2 sm:grid-cols-2 lg:min-h-0">
          <div className="relative min-h-0 overflow-hidden rounded-2xl border border-border bg-[#060608]">
            <canvas id="glCanvasVis" width={560} height={560} className="h-full w-full object-contain" />
            <div className="pointer-events-none absolute inset-x-2 top-2 flex items-center justify-between gap-2 rounded-md bg-black/50 px-2 py-1 font-mono text-[9.5px] uppercase tracking-wider text-white/80 backdrop-blur-sm">
              <span>3D — drag to orbit, right-drag to pan, scroll to scale</span>
              <span id="orbitHint" className="text-white/70" />
            </div>
          </div>
          <div className="relative min-h-0 overflow-hidden rounded-2xl border border-border bg-[#060608]">
            <canvas id="cv" width={700} height={700} className="h-full w-full object-contain" />
            <div className="pointer-events-none absolute inset-x-2 top-2 rounded-md bg-black/50 px-2 py-1 font-mono text-[9.5px] uppercase tracking-wider text-white/80 backdrop-blur-sm">
              2D — live pixel-dissolve output
            </div>
          </div>
        </div>

        {/* Right: controls — independently scrollable, fills the remaining viewport height */}
        <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto lg:h-full lg:w-[380px]">
          <GroupCard title="View">
            <div className="flex flex-wrap gap-2">
              <Button id="autoRotBtn" variant="outline" size="sm">
                Auto-rotate
              </Button>
              <Button id="resetViewBtn" variant="outline" size="sm">
                Reset view
              </Button>
            </div>
          </GroupCard>

          <GroupCard title="Lighting">
            <FieldSlider
              label="Light intensity"
              value={lightIntensity}
              display={lightIntensity.toFixed(2)}
              min={0.4}
              max={2.5}
              step={0.05}
              onChange={(v) => { setLightIntensity(v); engineRef.current?.setLightIntensity(v); }}
            />
            <FieldSlider
              label="Light contrast"
              value={lightContrast}
              display={lightContrast.toFixed(2)}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => { setLightContrast(v); engineRef.current?.setLightContrast(v); }}
            />
          </GroupCard>

          <GroupCard title="3D model">
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => document.getElementById('objInput')?.click()}>
                Load OBJ
              </Button>
              <input type="file" id="objInput" accept=".obj" className="hidden" />
              <Button variant="outline" size="sm" onClick={() => document.getElementById('glbInput')?.click()}>
                Load GLB
              </Button>
              <input type="file" id="glbInput" accept=".glb" className="hidden" />
            </div>
            <div className="hint hidden flex-col gap-2" id="animHint">
              <div className="flex flex-wrap gap-2">
                <Button id="animPlayBtn" variant="outline" size="sm">
                  ▶ Play animation
                </Button>
              </div>
            </div>
            <div className="hint hint-warn hidden" id="glbWarnHint" />
          </GroupCard>

          <GroupCard title="Export">
            <FieldSlider
              label="PNG resolution"
              value={exportScale}
              display={exportPixels}
              min={1}
              max={6}
              step={1}
              onChange={(v) => { setExportScale(v); engineRef.current?.setExportScale(v); }}
            />
            <div className="flex flex-wrap gap-2">
              <Button id="downloadPngBtn" variant="outline" size="sm">
                ⭳ PNG (alpha)
              </Button>
            </div>
            <Separator />
            <FieldSlider
              label="Duration (s)"
              value={frameSeqDur}
              display={frameSeqDur.toFixed(1)}
              min={1}
              max={20}
              step={0.5}
              onChange={(v) => { setFrameSeqDur(v); engineRef.current?.setFrameSeqDuration(v); }}
            />
            <FieldSlider
              label="FPS"
              value={frameSeqFps}
              display={String(frameSeqFps)}
              min={12}
              max={60}
              step={1}
              onChange={(v) => { setFrameSeqFps(v); engineRef.current?.setFrameSeqFps(v); }}
            />
            <div className="flex flex-wrap gap-2">
              <Button id="exportFramesBtn" variant="outline" size="sm">
                ⭳ Export frames (ZIP)
              </Button>
              <Button id="frameSeqCancelBtn" variant="outline" size="sm" className="hidden">
                Cancel
              </Button>
            </div>
            <div className="hint hidden" id="frameSeqStatus" />
            <HintDetails summary="What do these do?">
              PNG (alpha) grabs a single high-res transparent still. Export frames renders every
              frame individually (true transparency, no dropped/stuttered frames since it isn&apos;t
              tied to real time) and bundles them as numbered PNGs into one ZIP — import that
              sequence into your video tool to get an alpha video. Frame export needs the 3D
              source and can take a while at high resolutions/frame counts; progress shows above.
            </HintDetails>
            <div className="hint" id="exportHint" />
          </GroupCard>

          <GroupCard title="Source">
            <div className="flex flex-wrap gap-2">
              <Button id="src3d" variant="outline" size="sm" className="active">
                3D
              </Button>
              <Button id="srcImage" variant="outline" size="sm">
                Image
              </Button>
            </div>
            <div className="hidden flex-wrap gap-2" id="uploadRow">
              <Button variant="outline" size="sm" onClick={() => document.getElementById('pngInput')?.click()}>
                PNG
              </Button>
              <input type="file" id="pngInput" accept="image/png" className="hidden" />
            </div>
          </GroupCard>

          <GroupCard title="Halftone">
            <FieldSlider
              label="Resolution"
              value={cellSize}
              display={String(cellSize)}
              min={40}
              max={260}
              step={1}
              onChange={(v) => { setCellSize(v); engineRef.current?.setCellSize(v); }}
            />
            <div className="flex flex-col gap-1.5">
              <Label className="font-mono text-[11px] text-muted-foreground">Base shape</Label>
              <Select
                value={dotShape}
                onValueChange={(v) => { setDotShape(v as string); engineRef.current?.setDotShape(v as string); }}
              >
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="circle">Dot</SelectItem>
                  <SelectItem value="square">Square</SelectItem>
                  <SelectItem value="ascii">ASCII symbol</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <FieldSlider
              label="Dot scale"
              value={dotScale}
              display={dotScale.toFixed(2)}
              min={0.3}
              max={1.6}
              step={0.05}
              onChange={(v) => { setDotScale(v); engineRef.current?.setDotScale(v); }}
            />
            <FieldSlider
              label="Brightness curve"
              value={dotGamma}
              display={dotGamma.toFixed(2)}
              min={0.3}
              max={2.5}
              step={0.05}
              onChange={(v) => { setDotGamma(v); engineRef.current?.setDotGamma(v); }}
            />
            <FieldSlider
              label="Dust spread"
              value={dissolve}
              display={dissolve.toFixed(2)}
              min={0.06}
              max={0.6}
              step={0.01}
              onChange={(v) => { setDissolve(v); engineRef.current?.setDissolveSpread(v); }}
            />
            <FieldSlider
              label="Dust spread randomness"
              value={edgeRand}
              display={edgeRand.toFixed(2)}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => { setEdgeRand(v); engineRef.current?.setEdgeRandomness(v); }}
            />
          </GroupCard>

          <GroupCard title="Glow">
            <FieldSlider
              label="Glow amount"
              value={glowAmt}
              display={glowAmt.toFixed(2)}
              min={0}
              max={1.5}
              step={0.05}
              onChange={(v) => { setGlowAmt(v); engineRef.current?.setGlowAmt(v); }}
            />
            <FieldSlider
              label="Glow size"
              value={glowSize}
              display={glowSize.toFixed(2)}
              min={0.2}
              max={3}
              step={0.1}
              onChange={(v) => { setGlowSize(v); engineRef.current?.setGlowSize(v); }}
            />
          </GroupCard>

          <GroupCard title="Glitch">
            <div className="field-row items-center">
              <Label htmlFor="glitchEnabled">Color dispersion glitch</Label>
              <Switch
                id="glitchEnabled"
                checked={glitchEnabled}
                onCheckedChange={(v) => { setGlitchEnabled(v); engineRef.current?.setGlitchEnabled(v); }}
              />
            </div>
            <FieldSlider
              label="Frequency (bursts/sec)"
              value={glitchFreq}
              display={glitchFreq.toFixed(2)}
              min={0.05}
              max={4}
              step={0.05}
              onChange={(v) => { setGlitchFreq(v); engineRef.current?.setGlitchFrequency(v); }}
            />
            <FieldSlider
              label="Intensity"
              value={glitchIntensity}
              display={String(glitchIntensity)}
              min={1}
              max={35}
              step={1}
              onChange={(v) => { setGlitchIntensity(v); engineRef.current?.setGlitchIntensity(v); }}
            />
            <FieldSlider
              label="Duration (ms)"
              value={glitchDuration}
              display={String(glitchDuration)}
              min={20}
              max={400}
              step={10}
              onChange={(v) => { setGlitchDuration(v); engineRef.current?.setGlitchDuration(v); }}
            />
            <FieldSlider
              label="ASCII symbol size"
              value={glitchAsciiSize}
              display={glitchAsciiSize.toFixed(2)}
              min={0.1}
              max={1.6}
              step={0.05}
              onChange={(v) => { setGlitchAsciiSize(v); engineRef.current?.setGlitchAsciiSize(v); }}
            />
            <div className="flex gap-2">
              <ColorSwatch id="glitchColor0" defaultValue="#ff2050" label="1" />
              <ColorSwatch id="glitchColor1" defaultValue="#20ff90" label="2" />
              <ColorSwatch id="glitchColor2" defaultValue="#3090ff" label="3" />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button id="glitchReseedBtn" variant="outline" size="sm">
                ↻ Reseed glitch
              </Button>
            </div>
            <HintDetails summary="About this effect">
              holds still (no auto-flicker) whenever the model isn&apos;t actively animating — use
              reseed to get a new look
            </HintDetails>
          </GroupCard>

          <GroupCard title="Edge style">
            <FieldSlider
              label="Dust amount"
              value={dustAmt}
              display={dustAmt.toFixed(2)}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => { setDustAmt(v); engineRef.current?.setDustAmt(v); }}
            />
            <FieldSlider
              label="ASCII marks"
              value={asciiAmt}
              display={asciiAmt.toFixed(2)}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => { setAsciiAmt(v); engineRef.current?.setAsciiAmt(v); }}
            />
            <FieldSlider
              label="ASCII size"
              value={asciiSize}
              display={asciiSize.toFixed(2)}
              min={0.3}
              max={2.5}
              step={0.05}
              onChange={(v) => { setAsciiSize(v); engineRef.current?.setAsciiSize(v); }}
            />
            <div className="flex flex-wrap gap-2">
              <Button id="asciiColorModeBtn" variant="outline" size="sm">
                Accent colors
              </Button>
            </div>
            <div className="flex gap-2">
              <ColorSwatch id="asciiColor" defaultValue="#ffffff" label="ascii" />
            </div>
          </GroupCard>

          <GroupCard title="Body color">
            <div className="flex gap-2">
              <ColorSwatch id="bodyCol" defaultValue="#ffffff" label="body" />
            </div>
          </GroupCard>

          <GroupCard title="Edge accent colors">
            <div className="flex gap-2">
              <ColorSwatch id="col0" defaultValue="#ffffff" label="1" />
              <ColorSwatch id="col1" defaultValue="#ffffff" label="2" />
              <ColorSwatch id="col2" defaultValue="#ffffff" label="3" />
              <ColorSwatch id="col3" defaultValue="#ffffff" label="4" />
            </div>
            <FieldSlider
              label="Accent amount"
              value={accentAmt}
              display={accentAmt.toFixed(2)}
              min={0}
              max={1}
              step={0.01}
              onChange={(v) => { setAccentAmt(v); engineRef.current?.setAccentAmt(v); }}
            />
          </GroupCard>

          <GroupCard title="Seed">
            <Button id="reseedBtn" variant="outline" size="sm" className="self-start">
              ↻ Reseed
            </Button>
          </GroupCard>

          <Separator />
        </aside>
      </main>

      <canvas id="glCanvasSample" width={1} height={1} className="hidden" />
    </div>
  );
}
