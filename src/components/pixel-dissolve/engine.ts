// @ts-nocheck
//
// Ported near-verbatim from the original single-file Pixel Dissolve build (vanilla
// canvas/WebGL, no framework). This file intentionally stays untyped: it's the
// already-debugged rendering/parsing/export engine (halftone grid, hand-rolled WebGL
// matrix math, OBJ/GLB parsing, the color-dispersion glitch effect, PNG/video/frame-
// sequence export), and re-deriving it as fully-typed React state would risk
// reintroducing bugs that took many iterations to fix the first time. It operates on
// the DOM directly by element id, exactly as before — the surrounding React component
// just renders a matching DOM shape once and then hands control to `initPixelDissolveEngine`.
//
// Call once, after the matching markup has mounted. Safe to call only once per page —
// it wires up global (`window`) event listeners and starts its own requestAnimationFrame
// loop with no teardown, so the calling component is responsible for guarding against
// React StrictMode's double-invoke in development (see PixelDissolve.tsx).
import JSZip from 'jszip';

export function initPixelDissolveEngine() {
  const canvas = document.getElementById('cv') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  const CW = canvas.width, CH = canvas.height;

  let palette = ['#ffffff', '#ffffff', '#ffffff', '#ffffff'];
  let bodyColor = '#ffffff';
  let accentAmt = 0.30;
  ['col0', 'col1', 'col2', 'col3'].forEach((id, idx) => {
    document.getElementById(id)!.addEventListener('input', (e) => { palette[idx] = (e.target as HTMLInputElement).value; });
  });
  document.getElementById('bodyCol')!.addEventListener('input', (e) => { bodyColor = (e.target as HTMLInputElement).value; });
  // accentAmt is a slider, driven from React state — see the returned controller at the
  // bottom of this function instead of a getElementById listener here.

  let asciiColor = '#ffffff';
  let asciiColorMode = 'accent'; // 'accent' = same accent/body system as other cells | 'fixed' = asciiColor
  document.getElementById('asciiColor')!.addEventListener('input', (e) => { asciiColor = (e.target as HTMLInputElement).value; });
  document.getElementById('asciiColorModeBtn')!.addEventListener('click', (e) => {
    asciiColorMode = asciiColorMode === 'accent' ? 'fixed' : 'accent';
    const t = e.target as HTMLElement;
    t.textContent = asciiColorMode === 'accent' ? 'Accent colors' : 'Fixed color';
    t.classList.toggle('active', asciiColorMode === 'fixed');
  });

  let seed = 1337;
  function rand() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
  function hashNoise(x, y, o) {
    const s = Math.sin(x * 127.1 + y * 311.7 + o * 74.7) * 43758.5453;
    return s - Math.floor(s);
  }


  // ================= WebGL: minimal, no external libs =================
  const glCanvasVis = document.getElementById('glCanvasVis') as HTMLCanvasElement;
  let gl = null, glProgram = null, glBuffer = null, glVertCount = 0, glUniforms: any = {};
  let glOk = false;

  function m4Multiply(a, b) {
    const out = new Float32Array(16);
    for (let col = 0; col < 4; col++)
      for (let row = 0; row < 4; row++) {
        let sum = 0;
        for (let k = 0; k < 4; k++) sum += a[k*4+row] * b[col*4+k];
        out[col*4+row] = sum;
      }
    return out;
  }
  function m4Perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy/2), nf = 1/(near-far);
    return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]);
  }
  function vSub(a,b){return [a[0]-b[0],a[1]-b[1],a[2]-b[2]];}
  function vCross(a,b){return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];}
  function vDot(a,b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
  function vNorm(a){const l=Math.hypot(a[0],a[1],a[2])||1;return [a[0]/l,a[1]/l,a[2]/l];}
  function m4LookAt(eye, center, up) {
    const z = vNorm(vSub(eye, center));
    const x = vNorm(vCross(up, z));
    const y = vCross(z, x);
    return new Float32Array([x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0,
      -vDot(x,eye), -vDot(y,eye), -vDot(z,eye), 1]);
  }
  function m4RotZ(a){const c=Math.cos(a),s=Math.sin(a);return new Float32Array([c,s,0,0, -s,c,0,0, 0,0,1,0, 0,0,0,1]);}
  function m4RotX(a){const c=Math.cos(a),s=Math.sin(a);return new Float32Array([1,0,0,0, 0,c,s,0, 0,-s,c,0, 0,0,0,1]);}
  function m4Scale(s){return new Float32Array([s,0,0,0, 0,s,0,0, 0,0,s,0, 0,0,0,1]);}
  function m4TransformPoint(m, p) {
    return [
      m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12],
      m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13],
      m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14],
      m[3]*p[0]+m[7]*p[1]+m[11]*p[2]+m[15]
    ];
  }
  function rotX(p, a) { const c=Math.cos(a),s=Math.sin(a); return [p[0], p[1]*c - p[2]*s, p[1]*s + p[2]*c]; }
  function rotZ(p, a) { const c=Math.cos(a),s=Math.sin(a); return [p[0]*c - p[1]*s, p[0]*s + p[1]*c, p[2]]; }
  function addV(a,b){return [a[0]+b[0],a[1]+b[1],a[2]+b[2]];}

  function buildPetalTris(length, maxWidth, thickness, power, segs) {
    const outline = [[0,0]];
    for (let k = 1; k < segs; k++) { const t=k/segs, hw=maxWidth*Math.pow(Math.sin(Math.PI*t),power); outline.push([hw, t*length]); }
    outline.push([0, length]);
    for (let k = segs-1; k >= 1; k--) { const t=k/segs, hw=maxWidth*Math.pow(Math.sin(Math.PI*t),power); outline.push([-hw, t*length]); }
    const n = outline.length, tris = [];
    for (let i = 1; i < n-1; i++) tris.push([outline[0][0],outline[0][1],0],[outline[i][0],outline[i][1],0],[outline[i+1][0],outline[i+1][1],0]);
    for (let i = 1; i < n-1; i++) tris.push([outline[0][0],outline[0][1],thickness],[outline[i+1][0],outline[i+1][1],thickness],[outline[i][0],outline[i][1],thickness]);
    for (let i = 0; i < n; i++) {
      const j = (i+1)%n;
      const a0=[outline[i][0],outline[i][1],0], a1=[outline[i][0],outline[i][1],thickness];
      const b0=[outline[j][0],outline[j][1],0], b1=[outline[j][0],outline[j][1],thickness];
      tris.push(a0,b0,b1, a0,b1,a1);
    }
    return tris;
  }
  function buildPrism(radius, height, segs) {
    const ring = [], tris = [];
    for (let k = 0; k < segs; k++) { const a=(k/segs)*Math.PI*2; ring.push([Math.cos(a)*radius, Math.sin(a)*radius]); }
    for (let k = 0; k < segs; k++) {
      const j=(k+1)%segs;
      const a0=[ring[k][0],ring[k][1],0], a1=[ring[k][0],ring[k][1],height];
      const b0=[ring[j][0],ring[j][1],0], b1=[ring[j][0],ring[j][1],height];
      tris.push(a0,b0,b1, a0,b1,a1);
    }
    return tris;
  }
  function buildBump(radius, scaleZ) {
    const p = { top:[0,0,radius*scaleZ], bottom:[0,0,-radius*scaleZ], px:[radius,0,0], nx:[-radius,0,0], py:[0,radius,0], ny:[0,-radius,0] };
    return [p.top,p.px,p.py, p.top,p.py,p.nx, p.top,p.nx,p.ny, p.top,p.ny,p.px,
            p.bottom,p.py,p.px, p.bottom,p.nx,p.py, p.bottom,p.ny,p.nx, p.bottom,p.px,p.ny];
  }
  function buildFlowerVertices() {
    const STEM_H = 1.6;
    let all = [];
    buildPrism(0.045, STEM_H, 8).forEach(p => all.push(p));
    buildBump(0.2, 0.55).forEach(p => all.push(addV(p, [0,0,STEM_H])));
    const nPetals = 8;
    for (let i = 0; i < nPetals; i++) {
      const tris = buildPetalTris(0.9, 0.32, 0.05, 0.55, 8);
      const angle = (i*2*Math.PI)/nPetals, tilt = 25*Math.PI/180;
      tris.forEach(p => { let q=rotX(p,tilt); q=rotZ(q,angle); q=addV(q,[0,0,STEM_H]); all.push(q); });
    }
    [[0.62,60],[0.95,220]].forEach(([z,angDeg]) => {
      const tris = buildPetalTris(0.5, 0.24, 0.04, 0.5, 7);
      const angle = angDeg*Math.PI/180, tilt = 20*Math.PI/180;
      tris.forEach(p => { let q=rotX(p,tilt); q=rotZ(q,angle); q=addV(q,[0,0,z]); all.push(q); });
    });
    const flat = new Float32Array(all.length*3);
    for (let i = 0; i < all.length; i++) { flat[i*3]=all[i][0]; flat[i*3+1]=all[i][1]; flat[i*3+2]=all[i][2]; }
    return flat;
  }

  let glNormalBuffer = null;

  function compileProgram(vsSrc, fsSrc) {
    function compile(type, src) {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    const vs = compile(gl.VERTEX_SHADER, vsSrc), fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    return prog;
  }

  function computeFlatNormals(flat) {
    const n = flat.length / 3;
    const normals = new Float32Array(flat.length);
    for (let t = 0; t < n; t += 3) {
      const ax=flat[t*3], ay=flat[t*3+1], az=flat[t*3+2];
      const bx=flat[t*3+3], by=flat[t*3+4], bz=flat[t*3+5];
      const cx=flat[t*3+6], cy=flat[t*3+7], cz=flat[t*3+8];
      const ux=bx-ax, uy=by-ay, uz=bz-az;
      const vx=cx-ax, vy=cy-ay, vz=cz-az;
      let nx=uy*vz-uz*vy, ny=uz*vx-ux*vz, nz=ux*vy-uy*vx;
      const len = Math.hypot(nx,ny,nz) || 1;
      nx/=len; ny/=len; nz/=len;
      for (let k = 0; k < 3; k++) { normals[t*3+k*3]=nx; normals[t*3+k*3+1]=ny; normals[t*3+k*3+2]=nz; }
    }
    return normals;
  }

  // Area-weighted centroid of a triangle-soup mesh — used as the rotation pivot for uploaded
  // models instead of the bounding-box center, so an asymmetric mesh (mass concentrated to one
  // side) still orbits around roughly where its actual material is, not just the midpoint of
  // its extents. Weighting each triangle's own centroid by its area (rather than averaging raw
  // vertices, which overweights densely-tessellated regions) is a robust stand-in for a true
  // volumetric center of mass — it works for open, non-manifold, or inconsistently-wound
  // meshes, which an arbitrary upload can't be guaranteed not to have.
  function computeMeshCentroid(flat) {
    const triCount = flat.length / 9;
    let cx = 0, cy = 0, cz = 0, totalArea = 0;
    for (let t = 0; t < triCount; t++) {
      const o = t*9;
      const ax=flat[o], ay=flat[o+1], az=flat[o+2];
      const bx=flat[o+3], by=flat[o+4], bz=flat[o+5];
      const cxp=flat[o+6], cyp=flat[o+7], czp=flat[o+8];
      const ux=bx-ax, uy=by-ay, uz=bz-az;
      const vx=cxp-ax, vy=cyp-ay, vz=czp-az;
      const crossX = uy*vz-uz*vy, crossY = uz*vx-ux*vz, crossZ = ux*vy-uy*vx;
      const area = Math.hypot(crossX, crossY, crossZ) * 0.5;
      const triCx = (ax+bx+cxp)/3, triCy = (ay+by+cyp)/3, triCz = (az+bz+czp)/3;
      cx += triCx * area; cy += triCy * area; cz += triCz * area;
      totalArea += area;
    }
    if (totalArea <= 0) return [0, 0, 0];
    return [cx/totalArea, cy/totalArea, cz/totalArea];
  }

  function initWebGL() {
    try {
      gl = glCanvasVis.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: true });
      if (!gl) return false;

      const vsSrc = `
        attribute vec3 aPos;
        attribute vec3 aNormal;
        uniform mat4 uMVP;
        uniform mat4 uModel;
        varying vec3 vNormal;
        varying vec3 vWorldPos;
        void main() {
          vNormal = mat3(uModel) * aNormal;
          vWorldPos = (uModel * vec4(aPos, 1.0)).xyz;
          gl_Position = uMVP * vec4(aPos, 1.0);
        }`;
      // Key + dim cool fill + specular + true view-angle rim, instead of the old flat single-
      // light diffuse. Shape read (and everything downstream that samples this render's
      // luminance — accent-color bias, highlight/shadow marks) depends on how much contrast
      // is actually present here, so a low ambient floor and a specular punch matter directly.
      const fsSrc = `
        precision highp float;
        varying vec3 vNormal;
        varying vec3 vWorldPos;
        uniform vec3 uBaseColor;
        uniform vec3 uLightDir;
        uniform vec3 uFillDir;
        uniform vec3 uEyePos;
        uniform float uLightIntensity;
        uniform float uLightContrast;
        void main() {
          vec3 n = normalize(vNormal);
          vec3 key = normalize(uLightDir);
          vec3 fill = normalize(uFillDir);
          vec3 viewDir = normalize(uEyePos - vWorldPos);

          float diffKey = max(dot(n, key), 0.0);
          float diffFill = max(dot(n, fill), 0.0) * 0.3;

          float ambientFloor = mix(0.42, 0.02, uLightContrast);
          float diffPow = mix(1.0, 0.4, uLightContrast);
          float shade = pow(diffKey, diffPow);

          vec3 halfDir = normalize(key + viewDir);
          float spec = pow(max(dot(n, halfDir), 0.0), 24.0) * mix(0.4, 0.75, uLightContrast);

          float rim = pow(1.0 - max(dot(n, viewDir), 0.0), 2.2) * 0.22;

          float lightAmt = (ambientFloor + (1.0-ambientFloor)*shade + diffFill) * uLightIntensity;
          vec3 color = uBaseColor * lightAmt + rim + spec;
          gl_FragColor = vec4(color, 1.0);
        }`;
      glProgram = compileProgram(vsSrc, fsSrc);
      glUniforms.uMVP = gl.getUniformLocation(glProgram, 'uMVP');
      glUniforms.uModel = gl.getUniformLocation(glProgram, 'uModel');
      glUniforms.uBaseColor = gl.getUniformLocation(glProgram, 'uBaseColor');
      glUniforms.uLightDir = gl.getUniformLocation(glProgram, 'uLightDir');
      glUniforms.uFillDir = gl.getUniformLocation(glProgram, 'uFillDir');
      glUniforms.uEyePos = gl.getUniformLocation(glProgram, 'uEyePos');
      glUniforms.uLightIntensity = gl.getUniformLocation(glProgram, 'uLightIntensity');
      glUniforms.uLightContrast = gl.getUniformLocation(glProgram, 'uLightContrast');

      flowerVertsCache = buildFlowerVertices();
      glBuffer = gl.createBuffer();
      glNormalBuffer = gl.createBuffer();
      uploadMeshToGL(flowerVertsCache);

      gl.enable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      return true;
    } catch (e) { console.warn('WebGL init failed:', e); return false; }
  }
  let flowerVertsCache = null;
  let usingCustomModel = false;
  let modelIsGLB = false; // true only for GLB uploads — OBJ has no defined up-axis convention
  function uploadMeshToGL(flat) {
    gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, flat, gl.STATIC_DRAW);
    glVertCount = flat.length / 3;
    const normals = computeFlatNormals(flat);
    gl.bindBuffer(gl.ARRAY_BUFFER, glNormalBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
  }
  function parseOBJ(text) {
    const verts = [], tris = [];
    const lines = text.split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] === 'v') {
        verts.push([parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3])]);
      } else if (parts[0] === 'f') {
        const idxs = parts.slice(1).map(p => {
          let i = parseInt(p.split('/')[0], 10);
          return i < 0 ? verts.length + i : i - 1;
        });
        for (let i = 1; i < idxs.length - 1; i++) tris.push(verts[idxs[0]], verts[idxs[i]], verts[idxs[i+1]]);
      }
    }
    if (!tris.length) throw new Error('No faces found in OBJ');
    const min = [Infinity,Infinity,Infinity], max = [-Infinity,-Infinity,-Infinity];
    for (const v of verts) for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], v[k]); max[k] = Math.max(max[k], v[k]); }
    const size = Math.max(max[0]-min[0], max[1]-min[1], max[2]-min[2]) || 1;
    const scale = 1.8 / size;
    const raw = new Float32Array(tris.length * 3);
    for (let i = 0; i < tris.length; i++) {
      raw[i*3] = tris[i][0]; raw[i*3+1] = tris[i][1]; raw[i*3+2] = tris[i][2];
    }
    // recenter on the mesh's own area-weighted centroid, not the bounding-box center, so it
    // both appears centered in the viewport and orbits around roughly its center of mass
    const centroid = computeMeshCentroid(raw);
    const flat = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i += 3) {
      flat[i]   = (raw[i]   - centroid[0]) * scale;
      flat[i+1] = (raw[i+1] - centroid[1]) * scale;
      flat[i+2] = (raw[i+2] - centroid[2]) * scale;
    }
    return flat;
  }
  document.getElementById('objInput')!.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files[0];
    if (!file || !glOk) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const flat = parseOBJ(reader.result as string);
        uploadMeshToGL(flat);
        usingCustomModel = true;
        modelIsGLB = false;
        currentAnim = null;
        animPlaying = false;
        document.getElementById('animHint')!.style.display = 'none';
        setGlbWarning(null);
        userRotY = 0.626; userRotX = 0.167; userPanX = 0; userPanY = 0; userScale = 1;
        setSource('3d');
      } catch (err) {
        console.warn('OBJ parse failed:', err);
        alert('Could not read that OBJ file: ' + err.message);
      }
    };
    reader.readAsText(file);
  });
  document.getElementById('resetModelBtn')!.addEventListener('click', () => {
    if (!glOk || !flowerVertsCache) return;
    uploadMeshToGL(flowerVertsCache);
    usingCustomModel = false;
    modelIsGLB = false;
    currentAnim = null;
    document.getElementById('animHint')!.style.display = 'none';
    setGlbWarning(null);
    userRotY = 0.626; userRotX = 0.167; userPanX = 0; userPanY = 0; userScale = 1;
    setSource('3d');
  });

  // ---- GLB (glTF binary) import: static mesh + simple TRS keyframe animation ----
  let currentAnim = null;   // { channels:{translation,rotation,scale}, duration, scale }
  let animPlaying = false;
  let animTime = 0;

  function parseGLB(buf) {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('Not a .glb file');
    const totalLength = dv.getUint32(8, true);
    let offset = 12, json = null, bin = null;
    while (offset < totalLength) {
      const chunkLen = dv.getUint32(offset, true);
      const chunkType = dv.getUint32(offset + 4, true);
      const start = offset + 8;
      if (chunkType === 0x4e4f534a) json = JSON.parse(new TextDecoder('utf-8').decode(new Uint8Array(buf, start, chunkLen)));
      else if (chunkType === 0x004e4942) bin = buf.slice(start, start + chunkLen);
      offset = start + chunkLen;
    }
    if (!json) throw new Error('No JSON chunk in .glb');
    return { json, bin };
  }

  const GLB_COMPONENT_BYTES = { 5120:1, 5121:1, 5122:2, 5123:2, 5125:4, 5126:4 };
  const GLB_TYPE_COMPONENTS = { SCALAR:1, VEC2:2, VEC3:3, VEC4:4, MAT4:16 };

  function readGLBAccessor(json, bin, idx) {
    const acc = json.accessors[idx];
    const bv = json.bufferViews[acc.bufferView];
    const numComp = GLB_TYPE_COMPONENTS[acc.type];
    const compBytes = GLB_COMPONENT_BYTES[acc.componentType];
    const elemSize = numComp * compBytes;
    const stride = bv.byteStride || elemSize;
    const base = (bv.byteOffset || 0) + (acc.byteOffset || 0);
    const dv = new DataView(bin);
    const out = new Float32Array(acc.count * numComp);
    for (let i = 0; i < acc.count; i++) {
      for (let c = 0; c < numComp; c++) {
        const p = base + i*stride + c*compBytes;
        let v;
        switch (acc.componentType) {
          case 5126: v = dv.getFloat32(p, true); break;
          case 5125: v = dv.getUint32(p, true); break;
          case 5123: v = dv.getUint16(p, true); break;
          case 5122: v = dv.getInt16(p, true); break;
          case 5121: v = dv.getUint8(p); break;
          default: v = dv.getInt8(p);
        }
        out[i*numComp + c] = v;
      }
    }
    return out;
  }

  function glbNodeLocalMatrix(node) {
    if (node.matrix) return new Float32Array(node.matrix);
    return m4FromTRS(node.translation || [0,0,0], node.rotation || [0,0,0,1], node.scale || [1,1,1]);
  }
  // Walks the full glTF scene graph and merges every mesh primitive it finds into one
  // triangle soup, each transformed by its own node's world matrix — rather than only ever
  // reading json.meshes[0].primitives[0]. A Blender/Mixamo export commonly splits a character
  // into several mesh parts (body, eyes, clothing) as separate nodes, so only taking the first
  // one silently dropped most of the model. Skinned meshes are placed in their bind pose (this
  // tool has no vertex-skinning support), using the mesh node's own transform, not the joints'.
  function collectMeshTriangles(json, bin) {
    const out = [];
    if (!json.nodes || !json.nodes.length) return new Float32Array(0);
    // Root = a node no other node lists as a child. Computed directly rather than trusting
    // scene.nodes, because treating every node as an independent root (the old fallback when
    // scene.nodes was missing) let a child get visited before its real parent, applying an
    // identity transform instead of the parent's — corrupting that part's position/scale. A
    // single mis-transformed part can then dominate the bounding box used for centering and
    // auto-scale, shrinking the actual model down to an invisible speck even though triangles
    // were extracted successfully.
    const isChild = new Set();
    for (const node of json.nodes) if (node && node.children) for (const c of node.children) isChild.add(c);
    const roots = json.nodes.map((_, i) => i).filter(i => !isChild.has(i));
    const identity = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    const visited = new Set();

    function visit(nodeIdx, parentMatrix) {
      if (visited.has(nodeIdx)) return; // guards against a malformed/cyclic node graph
      visited.add(nodeIdx);
      const node = json.nodes[nodeIdx];
      if (!node) return;
      const world = m4Multiply(parentMatrix, glbNodeLocalMatrix(node));
      if (node.mesh !== undefined && json.meshes[node.mesh]) {
        for (const prim of json.meshes[node.mesh].primitives) {
          if (prim.attributes.POSITION === undefined) continue;
          if (prim.mode !== undefined && prim.mode !== 4) continue; // triangle lists only
          const positions = readGLBAccessor(json, bin, prim.attributes.POSITION);
          let triPos;
          if (prim.indices !== undefined) {
            const idxArr = readGLBAccessor(json, bin, prim.indices);
            triPos = new Float32Array(idxArr.length * 3);
            for (let i = 0; i < idxArr.length; i++) {
              const vi = idxArr[i];
              triPos[i*3] = positions[vi*3]; triPos[i*3+1] = positions[vi*3+1]; triPos[i*3+2] = positions[vi*3+2];
            }
          } else {
            triPos = positions;
          }
          for (let i = 0; i < triPos.length; i += 3) {
            const p = m4TransformPoint(world, [triPos[i], triPos[i+1], triPos[i+2]]);
            out.push(p[0], p[1], p[2]);
          }
        }
      }
      if (node.children) for (const c of node.children) visit(c, world);
    }
    for (const r of roots) visit(r, identity);
    return new Float32Array(out);
  }

  function boundsOf(triPos) {
    const min=[Infinity,Infinity,Infinity], max=[-Infinity,-Infinity,-Infinity];
    for (let i=0;i<triPos.length;i+=3) for (let k=0;k<3;k++){ min[k]=Math.min(min[k],triPos[i+k]); max[k]=Math.max(max[k],triPos[i+k]); }
    return { min, max, rawSize: Math.max(max[0]-min[0], max[1]-min[1], max[2]-min[2]) };
  }
  function firstPrimitiveTriangles(json, bin) {
    const mesh = json.meshes[0];
    const prim = mesh.primitives && mesh.primitives[0];
    if (!prim || prim.attributes.POSITION === undefined) throw new Error('Mesh has no POSITION attribute');
    const positions = readGLBAccessor(json, bin, prim.attributes.POSITION);
    if (prim.indices === undefined) return positions;
    const idxArr = readGLBAccessor(json, bin, prim.indices);
    const triPos = new Float32Array(idxArr.length * 3);
    for (let i = 0; i < idxArr.length; i++) {
      const vi = idxArr[i];
      triPos[i*3] = positions[vi*3]; triPos[i*3+1] = positions[vi*3+1]; triPos[i*3+2] = positions[vi*3+2];
    }
    return triPos;
  }

  function glbToMeshAndAnim(json, bin) {
    if (!json.meshes || !json.meshes.length) throw new Error('No mesh in .glb');
    let triPos = collectMeshTriangles(json, bin);
    let b = triPos.length ? boundsOf(triPos) : null;
    // If the scene-graph merge came back empty, or came back with an absurd/non-finite extent
    // (a single mis-transformed part dragging the bounding box out to where the real model
    // shrinks to an invisible speck), fall back to just the first primitive, untransformed —
    // that's not as complete a picture, but it's guaranteed visible rather than a blank
    // viewport with no indication of what went wrong.
    if (!triPos.length || !isFinite(b.rawSize) || b.rawSize < 1e-6) {
      triPos = firstPrimitiveTriangles(json, bin);
      b = boundsOf(triPos);
    }
    const { rawSize } = b;
    const size = rawSize || 1;
    const normScale = 1.8/size;

    // Flag things this tool can't actually do anything with, so the user finds out from a
    // note in the panel rather than by staring at a blank or unchanged viewport.
    const warnings = [];
    const triCount = triPos.length / 9;
    if (triCount === 0 || !isFinite(rawSize) || rawSize < 1e-6) {
      warnings.push('This model has no visible geometry (empty or a single point) — nothing will render.');
    } else if (triCount > 50000) {
      warnings.push(`High triangle count (${triCount.toLocaleString()}) — this may run slowly.`);
    }
    if (json.materials && json.materials.length) {
      warnings.push("Materials, textures, and vertex colors aren't used — only the shape and animation.");
    }
    if (json.skins && json.skins.length) {
      warnings.push("This model uses skeletal/bone animation (skinning), which isn't supported — it's shown in its bind pose instead of animating.");
    }

    // recenter on the mesh's own area-weighted centroid, not the bounding-box center, so it
    // both appears centered in the viewport and orbits around roughly its center of mass
    const centroid = computeMeshCentroid(triPos);
    const flat = new Float32Array(triPos.length);
    for (let i=0;i<triPos.length;i+=3) {
      flat[i]=(triPos[i]-centroid[0])*normScale;
      flat[i+1]=(triPos[i+1]-centroid[1])*normScale;
      flat[i+2]=(triPos[i+2]-centroid[2])*normScale;
    }

    let anim = null;
    if (json.animations && json.animations.length) {
      const a = json.animations[0];
      const channels: any = {};
      let duration = 0;
      for (const ch of a.channels) {
        const sampler = a.samplers[ch.sampler];
        const path = ch.target.path;
        if (path !== 'translation' && path !== 'rotation' && path !== 'scale') continue;
        const times = readGLBAccessor(json, bin, sampler.input);
        const values = readGLBAccessor(json, bin, sampler.output);
        channels[path] = { times, values };
        duration = Math.max(duration, times[times.length-1] || 0);
      }
      if (Object.keys(channels).length) anim = { channels, duration: duration || 1, scale: normScale };
    }
    return { flat, anim, warnings };
  }

  function sampleGLBChannel(channel, t, numComp) {
    const { times, values } = channel;
    const n = times.length;
    let a = 0, b = 0, f = 0;
    if (t <= times[0]) { a = b = 0; }
    else if (t >= times[n-1]) { a = b = n-1; }
    else { a = 0; while (a < n-1 && times[a+1] < t) a++; b = a+1; f = (t-times[a])/((times[b]-times[a])||1); }
    const out = new Array(numComp);
    for (let c = 0; c < numComp; c++) {
      const va = values[a*numComp+c], vb = values[b*numComp+c];
      out[c] = va + (vb-va)*f;
    }
    return out;
  }

  function m4FromTRS(t, q, s) {
    const x=q[0],y=q[1],z=q[2],w=q[3];
    const x2=x+x,y2=y+y,z2=z+z;
    const xx=x*x2,xy=x*y2,xz=x*z2,yy=y*y2,yz=y*z2,zz=z*z2,wx=w*x2,wy=w*y2,wz=w*z2;
    const sx=s[0],sy=s[1],sz=s[2];
    return new Float32Array([
      (1-(yy+zz))*sx, (xy+wz)*sx, (xz-wy)*sx, 0,
      (xy-wz)*sy, (1-(xx+zz))*sy, (yz+wx)*sy, 0,
      (xz+wy)*sz, (yz-wx)*sz, (1-(xx+yy))*sz, 0,
      t[0], t[1], t[2], 1
    ]);
  }

  function currentAnimMatrix() {
    if (!currentAnim) return null;
    const t = currentAnim.duration > 0 ? animTime % currentAnim.duration : 0;
    const ch = currentAnim.channels;
    const trans = ch.translation ? sampleGLBChannel(ch.translation, t, 3) : [0,0,0];
    const rot = ch.rotation ? sampleGLBChannel(ch.rotation, t, 4) : [0,0,0,1];
    const scl = ch.scale ? sampleGLBChannel(ch.scale, t, 3) : [1,1,1];
    const s = currentAnim.scale;
    return m4FromTRS([trans[0]*s, trans[1]*s, trans[2]*s], rot, scl);
  }

  // glTF/GLB is always authored Y-up by spec, but this tool's camera treats Z as up (see the
  // [0,0,1] up-vector below) — without correcting for that, an unrotated GLB import lies on
  // its side. Applied as an extra rotation in the model matrix (not baked into the vertex
  // data at load time) so it also correctly re-orients any TRS animation on the file, which is
  // authored in that same original Y-up space.
  const GLB_AXIS_FIX = m4RotX(Math.PI/2);

  // Camera orbits a fixed target instead of the object rotating in place — smoother to
  // navigate, and it means crease-edge projection and the GL render always agree exactly
  // since both call this same function for their matrices.
  function computeSceneMatrices() {
    const baseZ = usingCustomModel ? 0 : 0.85;
    const proj = m4Perspective(45*Math.PI/180, glCanvasVis.width/glCanvasVis.height, 0.1, 20);
    const target = [-userPanX*2, -userPanY*2, baseZ];
    const radius = 4.5 / Math.max(0.15, userScale);
    const az = userRotY, el = Math.max(-1.45, Math.min(1.45, userRotX));
    const eye = [
      target[0] + radius*Math.cos(el)*Math.sin(az),
      target[1] - radius*Math.cos(el)*Math.cos(az),
      target[2] + radius*Math.sin(el)
    ];
    const view = m4LookAt(eye, target, [0,0,1]);
    const animMat = currentAnimMatrix();
    let model = animMat || new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    if (modelIsGLB) model = m4Multiply(GLB_AXIS_FIX, model);
    const mvp = m4Multiply(proj, m4Multiply(view, model));
    return { proj, view, model, mvp, eye, target };
  }

  const GLB_SIZE_WARN_BYTES = 20 * 1024 * 1024; // 20MB — a browser-side per-frame renderer, not a game engine
  function setGlbWarning(text) {
    const el = document.getElementById('glbWarnHint')!;
    if (text) { el.textContent = text; (el as HTMLElement).style.display = 'block'; }
    else { el.textContent = ''; (el as HTMLElement).style.display = 'none'; }
  }
  document.getElementById('glbInput')!.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files[0];
    if (!file || !glOk) return;
    setGlbWarning(null);
    const fileWarnings = [];
    if (file.size > GLB_SIZE_WARN_BYTES) {
      fileWarnings.push(`Large file (${(file.size/1024/1024).toFixed(1)}MB) — parsing or playback may be slow.`);
    }
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const { json, bin } = parseGLB(reader.result as ArrayBuffer);
        const { flat, anim, warnings } = glbToMeshAndAnim(json, bin);
        uploadMeshToGL(flat);
        usingCustomModel = true;
        modelIsGLB = true;
        currentAnim = anim;
        animTime = 0;
        animPlaying = false;
        document.getElementById('animPlayBtn')!.textContent = '▶ Play animation';
        document.getElementById('animPlayBtn')!.classList.remove('active');
        (document.getElementById('animHint') as HTMLElement)!.style.display = anim ? 'block' : 'none';
        userRotY = 0.626; userRotX = 0.167; userPanX = 0; userPanY = 0; userScale = 1;
        setSource('3d');
        setGlbWarning(fileWarnings.concat(warnings).join(' ') || null);
      } catch (err) {
        console.warn('GLB parse failed:', err);
        alert('Could not read that .glb file: ' + err.message);
        setGlbWarning(null);
      }
    };
    reader.readAsArrayBuffer(file);
  });
  document.getElementById('animPlayBtn')!.addEventListener('click', (e) => {
    animPlaying = !animPlaying;
    const t = e.target as HTMLElement;
    t.textContent = animPlaying ? '⏸ Pause animation' : '▶ Play animation';
    t.classList.toggle('active', animPlaying);
  });

  let lightIntensity = 1.15, lightContrast = 0.85;
  glOk = initWebGL();

  // ---- interactive orbit / pan / scale state ----
  let userRotY = 0.626, userRotX = 0.167, userPanX = 0, userPanY = 0, userScale = 1;
  let autoRotate = false, autoRotSpeed = 0.18;
  let dragging = null, lastPX = 0, lastPY = 0;
  const orbitHint = document.getElementById('orbitHint');

  function beginDrag(clientX, clientY, isPan) {
    dragging = isPan ? 'pan' : 'orbit';
    lastPX = clientX; lastPY = clientY;
  }
  function moveDrag(clientX, clientY) {
    if (!dragging) return;
    const dx = clientX - lastPX, dy = clientY - lastPY;
    lastPX = clientX; lastPY = clientY;
    if (dragging === 'orbit') {
      userRotY += dx * 0.01;
      userRotX = Math.max(-1.45, Math.min(1.45, userRotX + dy * 0.01));
    } else {
      userPanX += dx * 0.0026;
      userPanY -= dy * 0.0026;
    }
    if (orbitHint) orbitHint.textContent = 'rotY ' + userRotY.toFixed(2) + ' rotX ' + userRotX.toFixed(2);
  }
  function endDrag() { dragging = null; }

  glCanvasVis.addEventListener('mousedown', (e) => {
    e.preventDefault();
    beginDrag(e.clientX, e.clientY, e.button === 2 || e.shiftKey);
  });
  window.addEventListener('mousemove', (e) => moveDrag(e.clientX, e.clientY));
  window.addEventListener('mouseup', endDrag);

  glCanvasVis.addEventListener('touchstart', (e) => {
    if (e.touches.length) { e.preventDefault(); beginDrag(e.touches[0].clientX, e.touches[0].clientY, e.touches.length > 1); }
  }, { passive: false });
  window.addEventListener('touchmove', (e) => {
    if (dragging && e.touches.length) { e.preventDefault(); moveDrag(e.touches[0].clientX, e.touches[0].clientY); }
  }, { passive: false });
  window.addEventListener('touchend', endDrag);

  glCanvasVis.addEventListener('wheel', (e) => {
    e.preventDefault();
    userScale = Math.max(0.35, Math.min(3, userScale * (1 - e.deltaY * 0.001)));
  }, { passive: false });
  glCanvasVis.addEventListener('contextmenu', (e) => e.preventDefault());

  document.getElementById('autoRotBtn')!.addEventListener('click', (e) => {
    autoRotate = !autoRotate;
    (e.target as HTMLElement).classList.toggle('active', autoRotate);
  });
  document.getElementById('resetViewBtn')!.addEventListener('click', () => {
    userRotY = 0.626; userRotX = 0.167; userPanX = 0; userPanY = 0; userScale = 1;
  });
  // lightIntensity / lightContrast are sliders, driven from React state — see the returned
  // controller at the bottom of this function.

  function renderWebGLFrame(mode) {
    // mode: 'nogrid-lit' (mask + shading, sampled for the silhouette and per-cell luminance) |
    // 'display' (what the user actually sees) — both render to the visible canvas.
    gl.viewport(0, 0, glCanvasVis.width, glCanvasVis.height);
    gl.clearColor(0.024, 0.024, 0.031, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const { mvp, model, eye } = computeSceneMatrices();

    gl.useProgram(glProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, glBuffer);
    const loc = gl.getAttribLocation(glProgram, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, glNormalBuffer);
    const nloc = gl.getAttribLocation(glProgram, 'aNormal');
    gl.enableVertexAttribArray(nloc);
    gl.vertexAttribPointer(nloc, 3, gl.FLOAT, false, 0, 0);
    gl.uniformMatrix4fv(glUniforms.uMVP, false, mvp);
    gl.uniformMatrix4fv(glUniforms.uModel, false, model);
    gl.uniform3f(glUniforms.uBaseColor, 0.66, 0.58, 0.82);
    gl.uniform3f(glUniforms.uLightDir, 0.5, -0.6, 0.9);
    gl.uniform3f(glUniforms.uFillDir, -0.45, 0.5, -0.35);
    gl.uniform3f(glUniforms.uEyePos, eye[0], eye[1], eye[2]);
    gl.uniform1f(glUniforms.uLightIntensity, lightIntensity);
    gl.uniform1f(glUniforms.uLightContrast, lightContrast);
    gl.drawArrays(gl.TRIANGLES, 0, glVertCount);
  }

  function flowerInsideFlat(u, v) {
    const bx=0, by=-0.32, du=u-bx, dv=v-by;
    const rBloom=Math.hypot(du,dv), aBloom=Math.atan2(dv,du);
    const petalR = 0.30 + 0.42*Math.pow(Math.max(0,Math.cos(aBloom*4)),0.7);
    if (rBloom < Math.max(petalR,0.16)) return true;
    if (Math.abs(u) < 0.045 && v > by+0.05 && v < 0.92) return true;
    for (const s of [1,-1]) { const dlu=(u-s*0.30)*s, dlv=v-0.28; if (Math.hypot(dlu*1.6,dlv*2.4) < 0.20) return true; }
    return false;
  }

  let sourceMode = '3d';
  let externalMask = null;
  let externalLumGrid = null;

  document.getElementById('src3d')!.addEventListener('click', () => setSource('3d'));
  document.getElementById('srcImage')!.addEventListener('click', () => setSource('image'));
  document.getElementById('srcVideo')!.addEventListener('click', () => setSource('video'));

  function setSource(mode) {
    sourceMode = mode;
    ['src3d','srcImage','srcVideo'].forEach(id => document.getElementById(id)!.classList.remove('active'));
    document.getElementById('src' + (mode==='3d'?'3d':mode.charAt(0).toUpperCase()+mode.slice(1)))!.classList.add('active');
    (document.getElementById('uploadRow') as HTMLElement)!.style.display = mode === '3d' ? 'none' : 'flex';
    (glCanvasVis as HTMLElement).style.opacity = mode === '3d' ? '1' : '0.35';
    if (mode === 'video') videoEl.play().catch(() => {});
    if (mode === '3d' && !glOk) externalMask = null;
  }

  document.getElementById('pngInput')!.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files[0]; if (!file) return;
    const img = new Image();
    img.onload = () => { externalMask = sampleImageToMask(img, cols(), rows(), 'alpha'); setSource('image'); };
    img.src = URL.createObjectURL(file);
  });
  const videoEl = document.getElementById('videoEl') as HTMLVideoElement;
  document.getElementById('mp4Input')!.addEventListener('change', (e) => {
    const file = (e.target as HTMLInputElement).files[0]; if (!file) return;
    videoEl.src = URL.createObjectURL(file);
    videoEl.addEventListener('loadeddata', () => setSource('video'), { once: true });
  });

  function sampleImageToMask(src, c, r, mode) {
    const off = document.createElement('canvas'); off.width=c; off.height=r;
    const octx = off.getContext('2d')!;
    octx.clearRect(0,0,c,r);
    const iw = src.videoWidth || src.naturalWidth || src.width;
    const ih = src.videoHeight || src.naturalHeight || src.height;
    const scale = Math.min(c/iw, r/ih);
    const dw = iw*scale, dh = ih*scale;
    octx.drawImage(src, (c-dw)/2, (r-dh)/2, dw, dh);
    const data = octx.getImageData(0,0,c,r).data;
    const mask = new Uint8Array(c*r);
    const bg = [6, 6, 8]; // matches gl.clearColor(0.024,0.024,0.031) used by the 3D viewport
    for (let j=0;j<r;j++) for (let i=0;i<c;i++) {
      const idx=(j*c+i)*4;
      if (mode === 'alpha') { mask[j*c+i] = data[idx+3] > 40 ? 1 : 0; }
      else if (mode === 'bgdist') {
        const dr = data[idx]-bg[0], dg = data[idx+1]-bg[1], db = data[idx+2]-bg[2];
        mask[j*c+i] = Math.sqrt(dr*dr+dg*dg+db*db) > 22 ? 1 : 0;
      } else {
        const lum = 0.299*data[idx]+0.587*data[idx+1]+0.114*data[idx+2];
        mask[j*c+i] = lum > 40 ? 1 : 0;
      }
    }
    return mask;
  }

  function sampleLitGrid(src, c, r) {
    const off = document.createElement('canvas'); off.width=c; off.height=r;
    const octx = off.getContext('2d')!;
    octx.clearRect(0,0,c,r);
    const iw = src.videoWidth || src.naturalWidth || src.width;
    const ih = src.videoHeight || src.naturalHeight || src.height;
    const scale = Math.min(c/iw, r/ih);
    const dw = iw*scale, dh = ih*scale;
    octx.drawImage(src, (c-dw)/2, (r-dh)/2, dw, dh);
    const data = octx.getImageData(0,0,c,r).data;
    const mask = new Uint8Array(c*r);
    const lum = new Float32Array(c*r);
    const bg = [6, 6, 8]; // matches gl.clearColor(0.024,0.024,0.031) used by the 3D viewport
    for (let j=0;j<r;j++) for (let i=0;i<c;i++) {
      const idx=(j*c+i)*4;
      const dr = data[idx]-bg[0], dg = data[idx+1]-bg[1], db = data[idx+2]-bg[2];
      mask[j*c+i] = Math.sqrt(dr*dr+dg*dg+db*db) > 22 ? 1 : 0;
      lum[j*c+i] = (0.299*data[idx]+0.587*data[idx+1]+0.114*data[idx+2]) / 255;
    }
    return { mask, lum };
  }

  function distanceTransform(seedGrid, c, r) {
    const INF = 1e9;
    const dist = new Float32Array(c*r).fill(INF);
    for (let i=0;i<c*r;i++) if (seedGrid[i]) dist[i]=0;
    const D1=1, D2=1.4142135;
    for (let j=0;j<r;j++) for (let i=0;i<c;i++) {
      const idx=j*c+i; let d=dist[idx];
      if (i>0) d=Math.min(d,dist[idx-1]+D1);
      if (j>0) d=Math.min(d,dist[idx-c]+D1);
      if (i>0&&j>0) d=Math.min(d,dist[idx-c-1]+D2);
      if (i<c-1&&j>0) d=Math.min(d,dist[idx-c+1]+D2);
      dist[idx]=d;
    }
    for (let j=r-1;j>=0;j--) for (let i=c-1;i>=0;i--) {
      const idx=j*c+i; let d=dist[idx];
      if (i<c-1) d=Math.min(d,dist[idx+1]+D1);
      if (j<r-1) d=Math.min(d,dist[idx+c]+D1);
      if (i<c-1&&j<r-1) d=Math.min(d,dist[idx+c+1]+D2);
      if (i>0&&j<r-1) d=Math.min(d,dist[idx+c-1]+D2);
      dist[idx]=d;
    }
    return dist;
  }

  let cellSize = 130, dissolveSpread = 0.22, dustAmt = 0.30, edgeRandomness = 0.35, asciiAmt = 0.25, asciiSize = 1.0;
  let dotScale = 1.05, dotGamma = 0.85, dotShape = 'circle';
  let glowAmt = 0.6, glowSize = 1.0;

  // Color dispersion glitch: a brief burst of a handful of horizontal bands — like a
  // data-corrupted scanline read — rather than shifting the whole frame. Each band is cleared
  // and redrawn from a color-split, ASCII-shaped version of the frame, each channel nudged by
  // a single offset (no repeated/trailing copies — those filled the gaps between shapes with
  // solid color, which read as an opaque background bar instead of individually glitched
  // shapes). Everything outside the bands stays exactly as drawCells rendered it.
  let glitchEnabled = false;
  let glitchFrequency = 0.5; // average bursts per second
  let glitchIntensity = 10;  // max horizontal streak offset, px
  let glitchDuration = 130;  // burst length, ms
  let glitchColors = ['#ff2050', '#20ff90', '#3090ff'];
  let glitchAsciiSize = 0.45; // ASCII glyph size used inside the glitch, independent of dotScale
  const GLITCH_CH_SCALE = [1, 0.65, 0.85]; // relative offset per channel, for the color fringing
  const GLITCH_FEATHER = 0.35; // fraction of each band's height spent fading in/out at the edges
  let glitchActive = false, glitchUntil = 0, lastGlitchCheckMs = 0;
  let glitchManualHold = false; // true once "Reseed glitch" fires while the scene is motionless
  let glitchBands = [];
  const glitchAsciiSnap = document.createElement('canvas');
  const glitchTints = [document.createElement('canvas'), document.createElement('canvas'), document.createElement('canvas')];
  const glitchBandLayer = document.createElement('canvas');
  function generateGlitchBands() {
    const numBands = 2 + Math.floor(Math.random()*5);
    const bands = [];
    for (let b = 0; b < numBands; b++) {
      bands.push({
        y0: Math.random(),                          // fraction of canvas height
        height: 0.012 + Math.random()*0.05,          // fraction of canvas height
        mag: glitchIntensity * (0.6 + Math.random()*1.3) * (Math.random() < 0.5 ? -1 : 1),
      });
    }
    return bands;
  }
  // A model that isn't actually animating (a static OBJ, or a GLB with its animation paused)
  // renders the exact same frame every tick, so continuing to auto-trigger bursts there just
  // reads as random flicker on what should be a still image — there's no ongoing motion for a
  // "random moment" to interrupt. So auto-triggering only runs while a GLB animation is
  // actually playing; otherwise whatever glitch state is already showing (on or off) just
  // holds, and "Reseed glitch" is how you deliberately pick a new one.
  function isSceneMotionless() {
    return !(sourceMode === '3d' && animPlaying);
  }
  function maybeTriggerGlitch(nowMs) {
    if (!glitchEnabled) { glitchActive = false; glitchManualHold = false; lastGlitchCheckMs = nowMs; return; }
    if (isSceneMotionless()) { lastGlitchCheckMs = nowMs; return; }
    if (glitchManualHold) { glitchManualHold = false; glitchActive = false; } // motion resumed: hand back to normal auto-triggering
    if (glitchActive) {
      if (nowMs > glitchUntil) glitchActive = false;
      return;
    }
    // frame-rate independent: probability scales with real elapsed time, not frame count,
    // so "bursts per second" means the same thing whether the tab is running at 30fps or 60fps
    const dt = lastGlitchCheckMs ? (nowMs - lastGlitchCheckMs) / 1000 : 0;
    lastGlitchCheckMs = nowMs;
    if (Math.random() < Math.min(0.9, glitchFrequency * dt)) {
      glitchActive = true;
      glitchUntil = nowMs + glitchDuration * (0.7 + Math.random()*0.6);
      glitchBands = generateGlitchBands();
    }
  }
  // Splits the frame into three colored, ASCII-shaped copies, each nudged by a single offset,
  // combined into a band-sized layer that's then feathered (top/bottom alpha ramp) before being
  // composited onto the frame. Nothing is erased first — the original content stays underneath
  // everywhere, so at full strength (band center) the glitch layer fully covers it, and at the
  // band edges it fades out, cross-fading smoothly back into the untouched original instead of
  // cutting off sharply. That also means it's naturally correct for both the opaque live canvas
  // and the transparent PNG export, with no separate case needed for either.
  function drawColorDispersionGlitch(targetCtx, w, h, bandsOverride?) {
    // an ASCII-shaped render of this same frame, kept transparent outside the actual shapes —
    // only ever shown inside the glitch bands, so the shape-break reads as "this strip
    // corrupted", not a global shape change. Sized independently of the normal dot scale via
    // glitchAsciiSize, so the glyphs can be tuned smaller without affecting the base render.
    glitchAsciiSnap.width = w; glitchAsciiSnap.height = h;
    const actx = glitchAsciiSnap.getContext('2d')!;
    drawCells(actx, w, h, 'ascii', glitchAsciiSize);

    for (let ci = 0; ci < 3; ci++) {
      const t = glitchTints[ci];
      t.width = w; t.height = h;
      const tctx = t.getContext('2d')!;
      tctx.drawImage(glitchAsciiSnap, 0, 0);
      // 'source-atop' recolors only the pixels the ascii shapes actually cover, keeping their
      // alpha — 'multiply' looked identical live (the canvas is opaque everywhere there) but
      // was secretly making the whole tint layer fully opaque, which is what turned into black
      // bars once the destination (the PNG export) actually had transparency to lose.
      tctx.globalCompositeOperation = 'source-atop';
      tctx.fillStyle = glitchColors[ci];
      tctx.fillRect(0, 0, w, h);
    }

    glitchBandLayer.width = w; glitchBandLayer.height = h;
    const blctx = glitchBandLayer.getContext('2d')!;

    for (const band of (bandsOverride || glitchBands)) {
      const y0 = Math.round(band.y0 * h);
      const bh = Math.max(1, Math.round(band.height * h));

      blctx.clearRect(0, y0, w, bh);
      blctx.globalCompositeOperation = 'lighter';
      for (let ci = 0; ci < 3; ci++) {
        const dx = band.mag * GLITCH_CH_SCALE[ci];
        blctx.drawImage(glitchTints[ci], 0, y0, w, bh, dx, y0, w, bh);
      }

      // feather: multiply this band's alpha by a vertical ramp (0 at both edges, 1 through the
      // middle) so the glitch fades in/out instead of stopping at a hard rectangle edge
      blctx.globalCompositeOperation = 'destination-in';
      const grad = blctx.createLinearGradient(0, y0, 0, y0 + bh);
      grad.addColorStop(0, 'rgba(0,0,0,0)');
      grad.addColorStop(GLITCH_FEATHER, 'rgba(0,0,0,1)');
      grad.addColorStop(1 - GLITCH_FEATHER, 'rgba(0,0,0,1)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      blctx.fillStyle = grad;
      blctx.fillRect(0, y0, w, bh);
      blctx.globalCompositeOperation = 'source-over';

      // composite the feathered band onto the frame — where it's transparent (edges, gaps
      // between shapes), the original already-rendered content shows through untouched
      targetCtx.drawImage(glitchBandLayer, 0, y0, w, bh, 0, y0, w, bh);
    }
  }
  // glitchEnabled (switch) and glitchFreq/glitchIntensity/glitchDuration/glitchAsciiSize
  // (sliders) are driven from React state — see the returned controller at the bottom of
  // this function. Colors stay native <input type="color">, wired below as before.
  ['glitchColor0', 'glitchColor1', 'glitchColor2'].forEach((id, idx) => {
    document.getElementById(id)!.addEventListener('input', (e) => { glitchColors[idx] = (e.target as HTMLInputElement).value; });
  });
  document.getElementById('glitchReseedBtn')!.addEventListener('click', () => {
    glitchEnabled = true;
    (document.getElementById('glitchEnabled') as HTMLInputElement).checked = true;
    glitchBands = generateGlitchBands();
    glitchActive = true;
    glitchManualHold = true; // holds this look until the model starts actually animating again
  });
  const asciiGlyphs = ['+', '-', 'x'];
  let cells: any[] = [];
  let colsN = cellSize, rowsN = Math.round(cellSize * (CH/CW));
  function cols(){ return colsN; }
  function rows(){ return rowsN; }

  function buildGrid() {
    colsN = cellSize;
    rowsN = Math.round(cellSize * (CH/CW));
    const c = colsN, r = rowsN;
    const inside = new Uint8Array(c*r);

    if (externalMask && externalMask.length === c*r) {
      for (let k=0;k<c*r;k++) inside[k] = externalMask[k];
    } else {
      for (let i=0;i<c;i++) {
        const u=(i/c-0.5)*2.3;
        for (let j=0;j<r;j++) {
          const v=(j/r-0.5)*2.3*(CH/CW)*(c/r);
          inside[j*c+i] = flowerInsideFlat(u,v) ? 1 : 0;
        }
      }
    }

    const insideSeed = new Uint8Array(c*r);
    for (let k=0;k<c*r;k++) insideSeed[k] = inside[k] ? 1 : 0;
    const distToInside = distanceTransform(insideSeed, c, r);

    const maxR = Math.max(c, r);
    const bandPxBase = Math.max(1.5, maxR * dissolveSpread);
    const seedOff = (seed % 10000) * 0.01;

    // sparse, shadow-biased, spatially-clustered accent color (or null = use body color).
    // Bright/lit cells mostly stay body-colored; darker/shadowed cells are more likely to
    // carry an accent, and same-color accents cluster into patches rather than scattering.
    function resolveAccent(i, j, idx) {
      const lum = externalLumGrid ? externalLumGrid[idx] : 0.55;
      const shadowFactor = Math.max(0, 1 - lum);
      const roll = hashNoise(i, j, 44);
      if (roll >= accentAmt * (0.2 + 0.9*shadowFactor)) return null;
      const clusterHash = hashNoise(Math.floor(i/5) + seedOff, Math.floor(j/5) + seedOff, 88);
      return palette[Math.min(3, Math.floor(clusterHash*4))];
    }

    cells = [];
    for (let i=0;i<c;i++) for (let j=0;j<r;j++) {
      const idx = j*c+i;

      // coarse, spatially-smooth hash so nearby cells share similar band width (organic, not per-pixel noise)
      const bandNoise = hashNoise(Math.floor(i/4) + seedOff, Math.floor(j/4) + seedOff, 77);
      const bandPx = Math.max(1.2, bandPxBase * (1 + edgeRandomness * 1.3 * (bandNoise*2 - 1)));

      if (inside[idx]) {
        // True halftone: dot size follows local brightness directly — bright surface = big
        // dot, dark surface = small/near-invisible dot — instead of a uniform fill that only
        // shrinks near the silhouette edge. A little per-cell jitter keeps the grain organic.
        const lum = externalLumGrid ? externalLumGrid[idx] : 0.65;
        const jitter = 0.9 + hashNoise(i, j, 5) * 0.2;
        const sizeT = Math.pow(Math.max(0, Math.min(1, lum)), dotGamma) * jitter;
        cells.push({ i, j, kind:'dot', sizeT, accentColor: resolveAccent(i,j,idx) });
      } else {
        const distIn = distToInside[idx];
        const bandDust = bandPx * (0.3 + 0.5*Math.max(dustAmt, asciiAmt));
        if (distIn > bandDust) continue;
        const proximity = Math.max(0, 1 - distIn/bandDust);

        if (asciiAmt > 0.001) {
          const asciiProb = proximity * (0.15 + 0.6*hashNoise(i,j,61)) * asciiAmt;
          if (hashNoise(i + seedOff, j + seedOff, 66) < asciiProb) {
            const glyphRoll = hashNoise(i, j, 71);
            const glyph = asciiGlyphs[Math.min(2, Math.floor(glyphRoll * 3))];
            cells.push({ i, j, kind:'ascii', glyph, accentColor: resolveAccent(i,j,idx) });
            continue;
          }
        }

        const dustProb = proximity * (0.15 + 0.6*hashNoise(i,j,9)) * dustAmt;
        if (hashNoise(i + seedOff, j + seedOff, 55) > dustProb) continue;
        const dustSize = 0.3 + 0.7*hashNoise(i,j,12);
        cells.push({ i, j, kind:'dust', sizeT: dustSize, accentColor: resolveAccent(i,j,idx) });
      }
    }
  }

  // Draws one halftone unit at (cx,cy) with the chosen base shape, sized by `extent` (roughly
  // a diameter — a circle of that diameter, a square of that side, or an ASCII glyph of about
  // that cap-height). i/j pick a stable-per-cell glyph for the 'ascii' shape.
  function drawShape(targetCtx, shape, cx, cy, extent, i, j) {
    if (extent < 0.24) return;
    if (shape === 'square') {
      targetCtx.fillRect(cx - extent/2, cy - extent/2, extent, extent);
    } else if (shape === 'ascii') {
      const glyph = asciiGlyphs[Math.min(2, Math.floor(hashNoise(i, j, 71) * 3))];
      targetCtx.font = 'bold ' + Math.round(extent*1.15) + 'px ui-monospace, Consolas, monospace';
      targetCtx.textAlign = 'center';
      targetCtx.textBaseline = 'middle';
      targetCtx.fillText(glyph, cx, cy + extent*0.06);
    } else {
      targetCtx.beginPath();
      targetCtx.arc(cx, cy, extent/2, 0, Math.PI*2);
      targetCtx.fill();
    }
  }

  function drawCells(targetCtx, targetW, targetH, shapeOverride?, dotScaleOverride?) {
    const c=colsN;
    const footW = targetW/c;
    const shape = shapeOverride || dotShape;
    const effDotScale = dotScaleOverride != null ? dotScaleOverride : dotScale;
    let rendered = 0;

    for (const cell of cells) {
      const px = cell.i*footW, py = cell.j*footW + targetH*0.02;
      const cx = px + footW/2, cy = py + footW/2;

      if (cell.kind === 'dot') {
        targetCtx.fillStyle = cell.accentColor || bodyColor;
        drawShape(targetCtx, shape, cx, cy, footW*effDotScale*cell.sizeT, cell.i, cell.j);
      } else if (cell.kind === 'ascii') {
        targetCtx.fillStyle = asciiColorMode === 'fixed' ? asciiColor : (cell.accentColor || bodyColor);
        targetCtx.font = 'bold ' + Math.round(footW*0.95*asciiSize) + 'px ui-monospace, Consolas, monospace';
        targetCtx.textAlign = 'center';
        targetCtx.textBaseline = 'middle';
        targetCtx.fillText(cell.glyph, cx, cy + footW*0.04);
      } else {
        targetCtx.fillStyle = cell.accentColor || bodyColor;
        drawShape(targetCtx, shape, cx, cy, footW*0.44*cell.sizeT, cell.i, cell.j);
      }

      rendered++;
    }

    // Glow: a soft blurred halo behind the brightest dots, layered on top of the crisp base
    // pass above rather than applied to everything — real bloom concentrates at highlights,
    // and shadowBlur is too costly in Canvas2D to run on every one of thousands of dots.
    if (glowAmt > 0.02) {
      const glowThreshold = 0.35;
      for (const cell of cells) {
        if (cell.kind !== 'dot' || cell.sizeT < glowThreshold) continue;
        const glowT = (cell.sizeT - glowThreshold) / (1 - glowThreshold);
        const px = cell.i*footW, py = cell.j*footW + targetH*0.02;
        const cx = px + footW/2, cy = py + footW/2;
        const color = cell.accentColor || bodyColor;
        targetCtx.shadowColor = color;
        targetCtx.shadowBlur = footW * glowSize * (0.6 + 2.2*glowT) * glowAmt;
        targetCtx.fillStyle = color;
        drawShape(targetCtx, shape, cx, cy, footW*effDotScale*cell.sizeT, cell.i, cell.j);
      }
      targetCtx.shadowBlur = 0;
    }

    return rendered;
  }

  function render2D() {
    ctx.clearRect(0,0,CW,CH);
    ctx.fillStyle = '#060608';
    ctx.fillRect(0,0,CW,CH);
    maybeTriggerGlitch(performance.now());
    const rendered = drawCells(ctx, CW, CH);
    // corrupted horizontal bands (color split + ASCII shapes) drawn on top, localized only —
    // see drawColorDispersionGlitch
    if (glitchActive) drawColorDispersionGlitch(ctx, CW, CH);
    document.getElementById('statusText')!.textContent = rendered + ' cells' + (glOk ? '' : ' · WebGL unavailable, using flat fallback');
  }

  // cellSize/dotScale/dotGamma/dotShape/glowAmt/glowSize/dissolve/edgeRand/dustAmt/asciiAmt/
  // asciiSize are sliders (or the shape select) driven from React state — see the returned
  // controller at the bottom of this function.
  document.getElementById('reseedBtn')!.addEventListener('click', () => { seed = Math.floor(Math.random()*1e9); });

  // ================= master loop =================
  let lastTs = 0;
  let exportingFrames = false; // paused while the frame-sequence exporter (below) owns the
                                // shared rotation/animation/glitch state and the GL canvas
  function masterLoop(ts) {
    if (exportingFrames) { requestAnimationFrame(masterLoop); return; }
    const dt = lastTs ? (ts - lastTs) / 1000 : 0;
    lastTs = ts;

    if (sourceMode === '3d' && glOk) {
      if (autoRotate && !dragging) userRotY += dt * autoRotSpeed;
      if (animPlaying) animTime += dt;
      renderWebGLFrame('nogrid-lit'); // mask + per-cell luminance
      const sampled = sampleLitGrid(glCanvasVis, cols(), rows());
      externalMask = sampled.mask;
      externalLumGrid = sampled.lum;
      renderWebGLFrame('display'); // what the user actually sees
    } else if (sourceMode === 'video') {
      externalMask = sampleImageToMask(videoEl, cols(), rows(), 'luminance');
      externalLumGrid = null;
    } else {
      externalLumGrid = null;
    }

    buildGrid();
    render2D();
    requestAnimationFrame(masterLoop);
  }

  // ================= downloads: PNG (alpha), video recording, frame-sequence ZIP =================
  // Plain browser downloads — no capability gating, no per-file size cap, no allowlisted
  // extensions. JSZip builds the frame-sequence archive.
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  let exportScale = 3;
  let frameSeqDuration = 4.0, frameSeqFps = 24;
  const downloadPngBtn = document.getElementById('downloadPngBtn')!;
  const recordBtn = document.getElementById('recordBtn')!;
  const recordAnimBtn = document.getElementById('recordAnimBtn')!;
  const exportFramesBtn = document.getElementById('exportFramesBtn') as HTMLButtonElement;
  const frameSeqCancelBtn = document.getElementById('frameSeqCancelBtn')!;
  const frameSeqStatus = document.getElementById('frameSeqStatus')!;
  const exportHint = document.getElementById('exportHint')!;
  function setFrameSeqStatus(text, isWarn?) {
    if (!text) { (frameSeqStatus as HTMLElement).style.display = 'none'; return; }
    frameSeqStatus.textContent = text;
    frameSeqStatus.classList.toggle('hint-warn', !!isWarn);
    (frameSeqStatus as HTMLElement).style.display = '';
  }

  // exportScale/frameSeqDuration/frameSeqFps are sliders driven from React state — see the
  // returned controller at the bottom of this function.

  exportHint.textContent = 'downloads save straight to your browser\'s downloads folder';

  downloadPngBtn.addEventListener('click', () => {
    const exportW = CW * exportScale, exportH = CH * exportScale;
    const off = document.createElement('canvas');
    off.width = exportW; off.height = exportH;
    const octx = off.getContext('2d')!;
    drawCells(octx, exportW, exportH); // no background fill: stays transparent
    // Bake a fresh glitch burst into this still capture when the effect is turned on — a static
    // OBJ upload has no animation to glitch live over time, so this is how the effect reaches a
    // still-image export.
    if (glitchEnabled) drawColorDispersionGlitch(octx, exportW, exportH, generateGlitchBands());
    off.toBlob((blob) => {
      if (!blob) return;
      downloadBlob(blob, `pixel-dissolve-${exportW}x${exportH}.png`);
    }, 'image/png');
  });

  let mediaRecorder = null, recordedChunks: any[] = [], autoStopTimer: any = null;
  function pickVideoMime() {
    if (typeof MediaRecorder === 'undefined') return null;
    if (MediaRecorder.isTypeSupported('video/mp4')) return 'video/mp4';
    if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) return 'video/webm;codecs=vp9';
    if (MediaRecorder.isTypeSupported('video/webm')) return 'video/webm';
    return null;
  }
  // Shared by both the manual record button and the GLB "one clean loop" button below. Returns
  // the MediaRecorder on success so the caller can decide how/when to stop it, or null if
  // recording couldn't start (no downloads permission, already recording, unsupported browser).
  function startRecording(filenameBase, onStopped?) {
    if (mediaRecorder && mediaRecorder.state === 'recording') return null;
    const mime = pickVideoMime();
    if (!mime) { alert('Video recording is not supported in this browser.'); return null; }
    const stream = (canvas as any).captureStream(30);
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: mime });
    mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: mime });
      const ext = mime.indexOf('mp4') >= 0 ? 'mp4' : 'webm';
      if (onStopped) onStopped(ext);
      downloadBlob(blob, `${filenameBase}.${ext}`);
    };
    mediaRecorder.start();
    return mediaRecorder;
  }

  recordBtn.addEventListener('click', () => {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      return;
    }
    const rec = startRecording('pixel-dissolve', () => {
      recordBtn.textContent = '● Record video';
      recordBtn.classList.remove('active');
    });
    if (rec) {
      recordBtn.textContent = '■ Stop && save';
      recordBtn.classList.add('active');
    }
  });

  // GLB animations have a known duration, so this captures exactly one clean loop — starting
  // the animation from time zero and stopping the instant it wraps — instead of the user
  // having to hand-coordinate Play and Record/Stop themselves.
  recordAnimBtn.addEventListener('click', () => {
    if (!currentAnim || currentAnim.duration <= 0) return;
    if (mediaRecorder && mediaRecorder.state === 'recording') return;
    animTime = 0;
    animPlaying = true;
    const animPlayBtnEl = document.getElementById('animPlayBtn')!;
    animPlayBtnEl.textContent = '⏸ Pause animation';
    animPlayBtnEl.classList.add('active');
    const rec = startRecording('pixel-dissolve-animation', () => {
      recordAnimBtn.textContent = '⭳ Record animation (MP4)';
      recordAnimBtn.classList.remove('active');
    });
    if (!rec) return;
    recordAnimBtn.textContent = '● Recording…';
    recordAnimBtn.classList.add('active');
    clearTimeout(autoStopTimer);
    autoStopTimer = setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === 'recording') mediaRecorder.stop();
      animPlaying = false;
      animPlayBtnEl.textContent = '▶ Play animation';
      animPlayBtnEl.classList.remove('active');
    }, currentAnim.duration * 1000 + 150); // small pad so the last frame is fully captured
  });

  // Renders a deterministic frame sequence and bundles it as alpha PNGs in a single ZIP (via
  // JSZip). "Deterministic" is the point: each frame advances a virtual clock by exactly 1/fps
  // rather than real elapsed time, so the output can't stutter or drop frames no matter how long
  // any single frame actually takes to render in the browser — unlike a live screen/video capture.
  let frameSeqCancelRequested = false;
  frameSeqCancelBtn.addEventListener('click', () => { frameSeqCancelRequested = true; });

  exportFramesBtn.addEventListener('click', async () => {
    if (exportingFrames) return;
    if (sourceMode !== '3d' || !glOk) {
      setFrameSeqStatus('Frame sequence export currently only supports the 3D source.', true);
      return;
    }
    exportingFrames = true;
    frameSeqCancelRequested = false;
    const origText = exportFramesBtn.textContent;
    exportFramesBtn.disabled = true;
    (frameSeqCancelBtn as HTMLElement).style.display = '';
    setFrameSeqStatus('Starting…');

    // save everything this export is about to drive, so the live view picks back up exactly
    // where it left off once we're done
    const saved = {
      userRotY, animTime, glitchActive, glitchUntil, glitchBands, lastGlitchCheckMs, glitchManualHold,
    };

    try {
      const fps = frameSeqFps, duration = frameSeqDuration;
      const totalFrames = Math.max(1, Math.round(fps * duration));
      const dt = 1 / fps;
      const exportW = CW * exportScale, exportH = CH * exportScale;
      const pad = String(totalFrames).length;

      const zip = new JSZip();
      lastGlitchCheckMs = 0;
      let virtualMs = 0;
      const startMs = performance.now();

      for (let f = 0; f < totalFrames; f++) {
        if (frameSeqCancelRequested) throw new Error('Cancelled.');

        const elapsedS = (performance.now() - startMs) / 1000;
        const perFrameS = f > 0 ? elapsedS / f : 0;
        const etaS = perFrameS > 0 ? Math.round(perFrameS * (totalFrames - f)) : null;
        const etaTxt = etaS != null ? ` — est. ${etaS}s left` : '';
        exportFramesBtn.textContent = `Rendering ${f+1}/${totalFrames}…`;
        setFrameSeqStatus(`Rendering frame ${f+1} of ${totalFrames}${etaTxt}`);

        if (autoRotate) userRotY += dt * autoRotSpeed;
        if (animPlaying && currentAnim) animTime += dt;

        renderWebGLFrame('nogrid-lit');
        const sampled = sampleLitGrid(glCanvasVis, cols(), rows());
        externalMask = sampled.mask;
        externalLumGrid = sampled.lum;
        buildGrid();

        const off = document.createElement('canvas');
        off.width = exportW; off.height = exportH;
        const octx = off.getContext('2d')!;
        drawCells(octx, exportW, exportH); // no background fill: stays transparent

        if (glitchEnabled) {
          virtualMs += dt * 1000;
          maybeTriggerGlitch(virtualMs);
          if (glitchActive) drawColorDispersionGlitch(octx, exportW, exportH);
        }

        const blob = await new Promise((resolve) => off.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error(`Frame ${f+1} failed to encode (canvas may be too large for this browser — try a lower PNG resolution).`);
        zip.file(`frame_${String(f+1).padStart(pad,'0')}.png`, blob as Blob);

        // yield a tick so the tab stays responsive and the progress text actually paints
        await new Promise((r) => setTimeout(r, 0));
      }

      exportFramesBtn.textContent = 'Zipping…';
      setFrameSeqStatus('Zipping…');
      const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (meta) => {
        setFrameSeqStatus(`Zipping… ${Math.round(meta.percent)}%`);
      });
      downloadBlob(zipBlob, `pixel-dissolve-frames-${exportW}x${exportH}.zip`);
      setFrameSeqStatus(`Done — ${totalFrames} frames saved.`);
    } catch (err: any) {
      console.warn('Frame sequence export failed:', err);
      const cancelled = err && err.message === 'Cancelled.';
      setFrameSeqStatus(cancelled ? 'Cancelled.' : `Failed: ${err && err.message ? err.message : err}`, !cancelled);
    } finally {
      userRotY = saved.userRotY; animTime = saved.animTime;
      glitchActive = saved.glitchActive; glitchUntil = saved.glitchUntil;
      glitchBands = saved.glitchBands; lastGlitchCheckMs = saved.lastGlitchCheckMs;
      glitchManualHold = saved.glitchManualHold;
      exportFramesBtn.textContent = origText;
      exportFramesBtn.disabled = false;
      (frameSeqCancelBtn as HTMLElement).style.display = 'none';
      exportingFrames = false;
    }
  });

  setSource('3d');
  requestAnimationFrame(masterLoop);

  // Setters for the controls now rendered as real shadcn/Base UI components (Slider, Select,
  // Switch) instead of native inputs the engine could wire up by id itself — React owns these
  // controls' state and display value, and just pushes changes into the engine's own variables.
  return {
    setLightIntensity(v: number) { lightIntensity = v; },
    setLightContrast(v: number) { lightContrast = v; },
    setExportScale(v: number) { exportScale = v; },
    setFrameSeqDuration(v: number) { frameSeqDuration = v; },
    setFrameSeqFps(v: number) { frameSeqFps = v; },
    setCellSize(v: number) { cellSize = v; },
    setDotScale(v: number) { dotScale = v; },
    setDotGamma(v: number) { dotGamma = v; },
    setDotShape(v: string) { dotShape = v; },
    setGlowAmt(v: number) { glowAmt = v; },
    setGlowSize(v: number) { glowSize = v; },
    setDissolveSpread(v: number) { dissolveSpread = v; },
    setEdgeRandomness(v: number) { edgeRandomness = v; },
    setDustAmt(v: number) { dustAmt = v; },
    setAsciiAmt(v: number) { asciiAmt = v; },
    setAsciiSize(v: number) { asciiSize = v; },
    setAccentAmt(v: number) { accentAmt = v; },
    setGlitchEnabled(v: boolean) { glitchEnabled = v; },
    setGlitchFrequency(v: number) { glitchFrequency = v; },
    setGlitchIntensity(v: number) { glitchIntensity = v; },
    setGlitchDuration(v: number) { glitchDuration = v; },
    setGlitchAsciiSize(v: number) { glitchAsciiSize = v; },
  };
}

export type PixelDissolveEngine = ReturnType<typeof initPixelDissolveEngine>;
