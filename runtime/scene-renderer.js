/**
 * WebGL renderer for Alight Motion scenes (preset/project XML).
 *
 * Each layer is rasterized on a 2D canvas with its transform baked in (full
 * composition size), pushed through its effect chain using FBO ping-pong, and
 * finally composited onto the scene framebuffer. Effects run in screen space
 * (acScreenNorm = v_texCoord); effects that sample the layers below them
 * (`lift`, blend effects) get the accumulated scene texture bound to `comp`.
 */
import {
    buildFragmentShaderSource,
    buildVertexShaderSource,
    getUniformNames
} from './gl-runtime.js';
import { createScriptAnimator, createElementState } from './script-runtime.js';
import { evalChannelInto, evalScalar } from './scene-parser.js';

const IDENTITY_MAT3 = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/**
 * AM menyimpan `property name="size"` sebagai SETENGAH bentang layer (half-extent),
 * jadi bentang penuh = 2 x size. Dibuktikan dari preset: layer foto 540x960 +
 * scale 0.6667 -> 2*540*0.6667 = 720 = lebar comp; layer video 480.567x480.567
 * + scale (0.749, 1.332) -> 720x1280 = penuh frame. Karena itu x2 selalu dipakai
 * (heuristik lama "size ~ setengah frame" gagal di project dynamicResolution
 * yang comp-nya 720x1280 tapi export-nya 1080x1920).
 */
function detectSizeScale(scene) {
    return 2;
}
const IDENTITY_MAT4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * Matriks 2D gaya canvas [a,b,c,d,e,f]:
 *   x' = a*x + c*y + e,  y' = b*x + d*y + f
 * Hasil = A * B, jadi titik dikenai B dulu lalu A - sama seperti CTM canvas
 * (CTM_baru = CTM_lama * node saat ctx.translate/rotate/scale dipanggil).
 */
function mat2x3MulInto(out, A, B) {
    const r0 = A[0] * B[0] + A[2] * B[1];
    const r1 = A[1] * B[0] + A[3] * B[1];
    const r2 = A[0] * B[2] + A[2] * B[3];
    const r3 = A[1] * B[2] + A[3] * B[3];
    const r4 = A[0] * B[4] + A[2] * B[5] + A[4];
    const r5 = A[1] * B[4] + A[3] * B[5] + A[5];
    out[0] = r0; out[1] = r1; out[2] = r2; out[3] = r3; out[4] = r4; out[5] = r5;
}

const CONTENT_PX = [1, 1];
const MAT_ACC = new Float64Array([1, 0, 0, 1, 0, 0]);
const MAT_NODE = new Float64Array(6);

/**
 * Isi ruang koordinat layer untuk uniform shader.
 *
 * Alight Motion memberi efek dua ruang: acScreenNorm (0..1 di seluruh layar)
 * dengan tekstur input juga di ruang layar, dan acLayerNorm (0..1 di kotak
 * konten layer) dengan acLayerToScreen yang memetakan layer -> layar. Banyak
 * efek geometris (tiles, mirror, bend, polar, kaleidoscope, outline, ...)
 * memakai acLayerNorm lalu memetakannya balik lewat acLayerToScreen/l2s(),
 * jadi keduanya harus nyata, bukan identitas.
 *
 * @param m matriks canvas px [a,b,c,d,e,f] dari koordinat lokal layer (origin di
 *          pusat konten, sumbu y ke bawah) ke piksel kanvas.
 * @param w,h ukuran konten layer di kanvas (px)
 * @param W,H ukuran target render (px)
 */
function buildLayerSpace(out, m, w, h, W, H) {
    const a = m[0], b = m[1], c = m[2], d = m[3], e = m[4], f = m[5];

    // n (0..1 konten, y ke atas) -> uv layar (y ke atas).
    // p = ((n.x-0.5)*w, (0.5-n.y)*h) lalu dipetakan matriks kanvas, dan
    // canvasY -> uv.y = 1 - canvasY/H.
    const A00 = (a * w) / W;
    const A10 = (-c * h) / W;
    const A20 = (-a * w / 2 + c * h / 2 + e) / W;
    const A01 = (-b * w) / H;
    const A11 = (d * h) / H;
    const A21 = 1 - (-b * w / 2 + d * h / 2 + f) / H;

    // Semua shader AM memakai konvensi VEKTOR-BARIS: `vec4(v,0.,1.) * acLayerToScreen`.
    // Di GLSL, `v * M` menghitung out.j = dot(v, M[j]) (M[j] = KOLOM ke-j), jadi
    // elemen M[kolom j][baris i] harus berisi koefisien v_i untuk output j.
    // Akibatnya matriksnya disimpan TRANSPOSE dari susunan matematisnya, dan
    // translasi ada di indeks 3 dan 7 (bukan 12/13). Salah susun di sini bikin
    // acLayerNorm kehilangan translasi -> efek tile/mirror/flip jadi bergaris.
    let ts = out.toScreen;
    ts[0] = A00; ts[1] = A10; ts[2] = 0; ts[3] = A20;
    ts[4] = A01; ts[5] = A11; ts[6] = 0; ts[7] = A21;
    ts[8] = 0;   ts[9] = 0;   ts[10] = 1; ts[11] = 0;
    ts[12] = 0;  ts[13] = 0;  ts[14] = 0; ts[15] = 1;

    let det = A00 * A11 - A10 * A01;
    if (Math.abs(det) < 1e-12) det = det < 0 ? -1e-12 : 1e-12;
    const S00 = A11 / det, S01 = -A01 / det;
    const S10 = -A10 / det, S11 = A00 / det;

    let tl = out.toLayer;
    tl[0] = S00; tl[1] = S10; tl[2] = 0; tl[3] = -(S00 * A20 + S10 * A21);
    tl[4] = S01; tl[5] = S11; tl[6] = 0; tl[7] = -(S01 * A20 + S11 * A21);
    tl[8] = 0;   tl[9] = 0;   tl[10] = 1; tl[11] = 0;
    tl[12] = 0;  tl[13] = 0;  tl[14] = 0; tl[15] = 1;

    // acLayerSize: ukuran layer di layar (px). acLayerPivot dipakai sebagai
    // pecahan dari ukuran ini, jadi satuannya harus px layar.
    out.sizePx[0] = w * Math.hypot(a, b);
    out.sizePx[1] = h * Math.hypot(c, d);
    // Ukuran & pusat layer di ruang ter-normalisasi layar.
    out.sizeNorm[0] = Math.hypot(A00, A01);
    out.sizeNorm[1] = Math.hypot(A10, A11);
    // acLayerCenter dipakai AM sesudah acScreenNorm dibalik jadi y-ke-bawah
    // (mis. blocknoise/checker: acScreenNorm.y -> 1-acScreenNorm.y), jadi satuannya
    // piksel layar y-ke-bawah = f, bukan H-f.
    out.centerPx[0] = e;
    out.centerPx[1] = f;
    out.centerNorm[0] = e / W;
    out.centerNorm[1] = 1 - f / H;
    out.valid = true;
}

/** Warna 0..1 -> string rgba, tanpa alokasi array per frame. */
function cssColor(c) {
    const r = Math.round(Math.max(0, Math.min(1, c[0] || 0)) * 255);
    const g = Math.round(Math.max(0, Math.min(1, c[1] || 0)) * 255);
    const b = Math.round(Math.max(0, Math.min(1, c[2] || 0)) * 255);
    const a = c[3] === undefined ? 1 : Math.max(0, Math.min(1, c[3]));
    return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

// Mode blend AM -> faktor (src, dst). Angkanya sama dengan konstanta WebGL
// standar; dipakai tabel konstan supaya tidak membuat array baru tiap frame.
const BLEND_FACTORS = {
    normal: [770, 771],          // SRC_ALPHA, ONE_MINUS_SRC_ALPHA
    add: [770, 1],               // SRC_ALPHA, ONE
    plus: [770, 1],
    'linear-dodge': [770, 1],
    screen: [1, 769],            // ONE, ONE_MINUS_SRC_COLOR
    multiply: [774, 771],        // DST_COLOR, ONE_MINUS_SRC_ALPHA
    mask: [0, 770],              // ZERO, SRC_ALPHA (mengisi alpha scene dengan bentuk layer mask)
    'mask-fill': [770, 771],
    'mask-exclude': [0, 771],     // ZERO, ONE_MINUS_SRC_ALPHA (memotong alpha)
    'dst-in': [0, 770],
    'dst-out': [0, 771]
};

const GLSL_TYPE_FOR_PARAM = {
    spinner: 'float',
    slider: 'float',
    float: 'float',
    switch: 'bool',
    selector: 'int',
    point: 'vec2',
    xyz: 'vec3',
    'hue-disc': 'vec3',
    color: 'vec4',
    orient: 'mat4'
};

export class SceneRenderer {
    constructor(canvas, logCallback = console.log, options = {}) {
        this.canvas = canvas;
        this.log = logCallback;
        // Semua pass menggambar quad full-screen, jadi MSAA (antialias), depth,
        // dan stencil tidak ada gunanya dan bikin framebuffer default lebih berat.
        const attrs = {
            alpha: options.opaque === true ? false : true,
            antialias: false,
            depth: false,
            stencil: false,
            preserveDrawingBuffer: false,
            powerPreference: 'high-performance'
        };
        this.gl2 = canvas.getContext('webgl2', attrs) || null;
        this.gl = this.gl2 || canvas.getContext('webgl', attrs);
        if (!this.gl) throw new Error('WebGL tidak didukung di browser ini.');
        this.webglVersion = this.gl2 ? 2 : 1;
        this.log(`[WEBGL] Backend: WebGL${this.webglVersion} (GLSL ES ${this.webglVersion >= 2 ? '3.00' : '1.00'})`);

        this.scene = null;
        this.images = new Map();
        this.programs = new Map();
        this.failedEffects = new Set();
        this.targets = new Map();

        this.effectsEnabled = true;
        this._plans = new WeakMap();
        this._paramScratch = [0, 0, 0, 0];
        this._matScratch = new Float32Array(16);
        this._texSlots = { input: null, comp: null };
        this._layerSpace = {
            toScreen: new Float32Array(16),
            toLayer: new Float32Array(16),
            sizePx: [0, 0], sizeNorm: [0, 0],
            centerPx: [0, 0], centerNorm: [0, 0],
            valid: false
        };
        this.mediaScale = 1;
        this.sizeScale = 2;
        this.autoSizeScale = 2;
        this.workHeight = 480;
        this.workWidth = 270;
        this.baseWidth = 270;
        this.baseHeight = 480;
        this.timeMs = 0;
        this.stats = { layers: 0, passes: 0 };

        this.raster = document.createElement('canvas');
        this.rasterCtx = this.raster.getContext('2d');

        this._initGL();
    }

    // ---------------------------------------------------------------- GL setup

    _initGL() {
        const gl = this.gl;
        this.positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

        this.texCoordBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);

        this.placeholderTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.placeholderTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([30, 30, 40, 255]));
        this._texParams();

        this.blitProgram = this._program(this._plainVertex(), this._plainFragment());
        this.blitUniforms = this._uniforms(this.blitProgram);
        this.blitAttribs = this._attribs(this.blitProgram);
    }

    _plainVertex() {
        return this.webglVersion >= 2
            ? `#version 300 es
precision highp float;
in vec2 a_position;
in vec2 a_texCoord;
out vec2 v_texCoord;
uniform mat3 u_transform;
void main() {
    vec3 pos = u_transform * vec3(a_position, 1.0);
    gl_Position = vec4(pos.xy, 0.0, 1.0);
    v_texCoord = a_texCoord;
}
`
            : `precision highp float;
attribute vec2 a_position;
attribute vec2 a_texCoord;
varying vec2 v_texCoord;
uniform mat3 u_transform;
void main() {
    vec3 pos = u_transform * vec3(a_position, 1.0);
    gl_Position = vec4(pos.xy, 0.0, 1.0);
    v_texCoord = a_texCoord;
}
`;
    }

    _plainFragment() {
        return this.webglVersion >= 2
            ? `#version 300 es
precision highp float;
in vec2 v_texCoord;
out vec4 acFragColor;
uniform sampler2D u_image;
uniform float u_alpha;
void main() {
    vec4 c = texture(u_image, v_texCoord);
    acFragColor = vec4(c.rgb, c.a * u_alpha);
}
`
            : `precision highp float;
varying vec2 v_texCoord;
uniform sampler2D u_image;
uniform float u_alpha;
void main() {
    vec4 c = texture2D(u_image, v_texCoord);
    gl_FragColor = vec4(c.rgb, c.a * u_alpha);
}
`;
    }

    _texParams() {
        const gl = this.gl;
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    _shader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const info = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error(info.split('\n')[0]);
        }
        return shader;
    }

    _program(vsSource, fsSource) {
        const gl = this.gl;
        const vs = this._shader(gl.VERTEX_SHADER, vsSource);
        const fs = this._shader(gl.FRAGMENT_SHADER, fsSource);
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const info = gl.getProgramInfoLog(program);
            gl.deleteProgram(program);
            throw new Error(info.split('\n')[0]);
        }
        return program;
    }

    _uniforms(program) {
        const gl = this.gl;
        const out = {};
        const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < count; i++) {
            const info = gl.getActiveUniform(program, i);
            if (info) out[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(program, info.name);
        }
        return out;
    }

    _attribs(program) {
        const gl = this.gl;
        return {
            a_position: gl.getAttribLocation(program, 'a_position'),
            a_texCoord: gl.getAttribLocation(program, 'a_texCoord')
        };
    }

    _bindQuad(attribs) {
        const gl = this.gl;
        if (attribs.a_position >= 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
            gl.enableVertexAttribArray(attribs.a_position);
            gl.vertexAttribPointer(attribs.a_position, 2, gl.FLOAT, false, 0, 0);
        }
        if (attribs.a_texCoord >= 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
            gl.enableVertexAttribArray(attribs.a_texCoord);
            gl.vertexAttribPointer(attribs.a_texCoord, 2, gl.FLOAT, false, 0, 0);
        }
    }

    /** FBO + texture pair of a given size (cached per size). */
    _targetsFor(w, h, prefix = '') {
        const key = prefix + w + 'x' + h;
        let entry = this.targets.get(key);
        if (entry) return entry;
        const gl = this.gl;
        const make = () => {
            const tex = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            this._texParams();
            const fbo = gl.createFramebuffer();
            gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
            return { tex, fbo };
        };
        entry = { make, w, h, a: make(), b: make() };
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        this.targets.set(key, entry);
        return entry;
    }

    // ------------------------------------------------------------ state setup

    setScene(scene) {
        this.scene = scene;
        this.autoSizeScale = detectSizeScale(scene);
        this.sizeScale = this.autoSizeScale;
        this.log(`[SCENE] Satuan ukuran layer: x${this.sizeScale}${this.sizeScale === 2 ? ' (AM menyimpan size dalam satuan proxy 1/2)' : ''}`);
        this.setResolution(this.workHeight);
    }

    setResolution(height) {
        this.workHeight = Math.max(180, Math.round(height));
        this.workWidth = this.scene
            ? Math.max(2, Math.round((this.scene.width / this.scene.height) * this.workHeight))
            : this.workHeight;
        this.canvas.width = this.workWidth;
        this.canvas.height = this.workHeight;
        this.raster.width = this.workWidth;
        this.raster.height = this.workHeight;
        this.baseWidth = this.workWidth;
        this.baseHeight = this.workHeight;
        this.log(`[SCENE] Resolusi render: ${this.workWidth}x${this.workHeight}`);
    }

    setImages(map) {
        this.images = map;
    }

    /** Compiles every effect used by the scene. `fetchDefinition(id)` is async. */
    async loadEffectLibrary(effectIds, fetchDefinition) {
        this.programs.clear();
        this.failedEffects.clear();
        // Lokasi uniform/program bisa berubah -> semua binding harus dibuat ulang.
        this._plans = new WeakMap();
        let ok = 0;
        for (const id of effectIds) {
            if (this.programs.has(id)) continue;
            try {
                const definition = await fetchDefinition(id);
                this.programs.set(id, { ...this._compileEffect(definition), definition });
                ok++;
            } catch (e) {
                this.failedEffects.add(id);
                this.log(`[SCENE] Efek ${id} dilewati: ${String(e.message).split('\n')[0]}`);
            }
        }
        this.log(`[SCENE] ${ok} program efek siap, ${this.failedEffects.size} efek dilewati.`);
    }

    _compileEffect(definition) {
        const shaders = definition.shaders && definition.shaders.length
            ? definition.shaders
            : (definition.shader ? [definition.shader] : []);
        const animator = definition.script && definition.script.code
            ? createScriptAnimator(definition, this.log)
            : null;

        if (shaders.length) {
            const options = { webglVersion: this.webglVersion };
            const byGroup = new Map();
            const order = [];
            for (const group of shaders) {
                const key = String(group.group);
                if (byGroup.has(key)) continue;
                // Uniform di-rename berbeda per group (isinya beda), jadi semua
                // binding dihitung ulang untuk tiap varian shader.
                const variant = { ...definition, shader: group };
                try {
                    const program = this._program(
                        buildVertexShaderSource(variant, () => {}, options),
                        buildFragmentShaderSource(variant, () => {}, options)
                    );
                    byGroup.set(key, {
                        program,
                        uniforms: this._uniforms(program),
                        attribs: this._attribs(program),
                        uniformNames: getUniformNames(variant),
                        definition: variant
                    });
                    order.push(key);
                } catch (e) {
                    this.log('[SCENE] Shader group ' + key + ' dari ' + definition.id + ' dilewati: ' + String(e.message).split('\n')[0]);
                }
            }
            if (!byGroup.size) throw new Error('semua shader group gagal dikompilasi.');
            const first = byGroup.get(order[0]);
            return { ...first, programsByGroup: byGroup, groupOrder: order, animator };
        }
        if (animator) {
            const program = this._program(this._plainVertex(), this._plainFragment());
            return {
                program,
                uniforms: this._uniforms(program),
                attribs: this._attribs(program),
                uniformNames: new Map(),
                programsByGroup: null,
                groupOrder: [],
                animator
            };
        }
        throw new Error('efek native (tanpa shader/script) belum bisa dipreview.');
    }

    // ------------------------------------------------------------- rasterizing

    _drawMedia(ctx, img, x, y, w, h, mode) {
        if (!img) {
            ctx.fillStyle = 'rgba(70,70,90,0.6)';
            ctx.fillRect(x, y, w, h);
            return;
        }
        const iw = img.naturalWidth || img.width || 1;
        const ih = img.naturalHeight || img.height || 1;
        if (mode === 'stretch') {
            ctx.drawImage(img, x, y, w, h);
            return;
        }
        const scale = mode === 'fit' ? Math.min(w / iw, h / ih) : Math.max(w / iw, h / ih);
        const sw = Math.min(iw, w / scale);
        const sh = Math.min(ih, h / scale);
        ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, w, h);
    }

    /** Path bentuk layer (.rect default, .roundrect, .circle/.ellipse). */
    _shapePath(ctx, layer, w, h, radius) {
        const type = layer.shapeType || '.rect';
        ctx.beginPath();
        if (type === '.circle' || type === '.ellipse') {
            ctx.ellipse(0, 0, Math.max(0.5, w / 2), Math.max(0.5, h / 2), 0, 0, Math.PI * 2);
        } else if (type === '.roundrect' && radius > 0.5) {
            const r = Math.min(radius, Math.min(w, h) / 2);
            const x = -w / 2;
            const y = -h / 2;
            ctx.moveTo(x + r, y);
            ctx.lineTo(x + w - r, y);
            ctx.arcTo(x + w, y, x + w, y + r, r);
            ctx.lineTo(x + w, y + h - r);
            ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
            ctx.lineTo(x + r, y + h);
            ctx.arcTo(x, y + h, x, y + h - r, r);
            ctx.lineTo(x, y + r);
            ctx.arcTo(x, y, x + r, y, r);
            ctx.closePath();
        } else {
            ctx.rect(-w / 2, -h / 2, w, h);
        }
    }

    /** Ukuran konten layer di piksel kanvas (px). Buffer dipakai ulang. */
    _contentPx(layer, size) {
        const k = this.workHeight / ((layer._scene || this.scene).height);
        CONTENT_PX[0] = Math.max(1, size[0] * k);
        CONTENT_PX[1] = Math.max(1, size[1] * k);
        return CONTENT_PX;
    }

    /** Draws a layer's own content (no transform) into ctx. */
    _rasterizeLayer(layer, size, ctx) {
        const px = this._contentPx(layer, size);
        const w = px[0];
        const h = px[1];

        if (layer.tag === 'embedScene' && layer.scene) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(-w / 2, -h / 2, w, h);
            ctx.clip();
            ctx.translate(-w / 2, -h / 2);
            ctx.scale(w / layer.scene.width, h / layer.scene.height);
            this._drawSubScene(layer.scene, ctx, layer.scene.width, layer.scene.height, layer._subTimeMs, layer._subSpanMs);
            ctx.restore();
            return;
        }
        const type = layer.shapeType || '.rect';
        const radius = (layer.cornerRadius || 0) * (layer.size.value[0] > 0 ? w / layer.size.value[0] : 1);
        const shaped = type !== '.rect' && type !== '';

        if (layer.fillType === 'media') {
            const img = this.images.get(layer.fillImage);
            if (!img && layer.fillVideo) return;   // video belum bisa diputar -> jangan gambar kotak abu
            if (!shaped) {
                this._drawMedia(ctx, img, -w / 2, -h / 2, w, h, layer.mediaFillMode);
                return;
            }
            ctx.save();
            this._shapePath(ctx, layer, w, h, radius);
            ctx.clip();
            this._drawMedia(ctx, img, -w / 2, -h / 2, w, h, layer.mediaFillMode);
            ctx.restore();
            return;
        }
        if (layer.tag === 'nullobj') return;   // container transform, tidak punya isi
        const x0 = -w / 2 + ((layer.gradient && layer.gradient.start[0]) || 0) * w;
        const y0 = -h / 2 + ((layer.gradient && layer.gradient.start[1]) || 0) * h;
        const x1 = -w / 2 + ((layer.gradient && layer.gradient.end[0]) || 1) * w;
        const y1 = -h / 2 + ((layer.gradient && layer.gradient.end[1]) || 0) * h;

        if (layer.fillType === 'gradient' && layer.gradient) {
            const g = layer.gradient;
            const grad = ctx.createLinearGradient(x0, y0, x1, y1);
            grad.addColorStop(0, cssColor(g.startColor));
            grad.addColorStop(1, cssColor(g.endColor));
            ctx.fillStyle = grad;
        } else {
            ctx.fillStyle = cssColor(layer.fillColor);
        }
        if (shaped) {
            this._shapePath(ctx, layer, w, h, radius);
            ctx.fill();
        } else {
            ctx.fillRect(-w / 2, -h / 2, w, h);
        }
    }

    _contentSize(layer, scene) {
        if (layer.tag === 'embedScene' && layer.scene) return [layer.scene.width, layer.scene.height];
        const size = layer.size.value;
        // `size` = setengah bentang, jadi konten digambar 2x lipat. mediaFillMode
        // hanya mengatur cara media masuk ke kotak ini (fit/fill/stretch).
        const k = this.sizeScale || 1;
        let base = size[0] > 0 && size[1] > 0
            ? [size[0] * k, size[1] * k]
            : [scene.width, scene.height];
        if (this.mediaScale && this.mediaScale !== 1) {
            base = [base[0] * this.mediaScale, base[1] * this.mediaScale];
        }
        return base;
    }

    /** Nested scene (embedScene): layers are drawn straight into ctx. */
    _drawSubScene(subScene, ctx, subW, subH, timeMs, spanMs) {
        const prevW = this.workWidth;
        const prevH = this.workHeight;
        this.workWidth = subW;
        this.workHeight = subH;
        subScene.layers.forEach((layer) => { layer._scene = subScene; });

        const span = spanMs || subScene.totalTime || 1;
        ctx.save();
        try {
        for (const layer of subScene.layers) {
            const localMs = ((timeMs - (this.subSceneStartMs || 0)) / span) * subScene.totalTime;
            const u = this._layerU(layer, localMs);
            if (u === null) continue;
            const el = this._element(layer, u, localMs / 1000);
            if (el.alpha <= 0.002) continue;
            const size = this._contentSize(layer, subScene);
            const k = subH / subScene.height;
            ctx.save();
            ctx.globalAlpha = Math.max(0, Math.min(1, el.alpha));
            this._applyTransforms(ctx, layer, el, k, (localMs - layer.startTime) / 1000);
            this._rasterizeLayer(layer, size, ctx);
            ctx.restore();
        }
        ctx.restore();
        } finally {
            this.workWidth = prevW;
            this.workHeight = prevH;
        }
    }

    // ----------------------------------------------------------------- effects

    _upload(canvas, target, w, h) {
        const gl = this.gl;
        gl.bindTexture(gl.TEXTURE_2D, target.tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        // Tekstur target sudah dialokasikan di ukuran ini, jadi isi ulang saja
        // (texSubImage2D) alih-alih realokasi tiap layer tiap frame.
        if (target.w === canvas.width && target.h === canvas.height) {
            gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        } else {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        }
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    }

    _standardUniforms(entry, localSeconds, w, h, vel, velScale = 1, passIndex = 1) {
        const gl = this.gl;
        const u = entry.uniforms;
        // Ruang layer yang sudah dihitung di _drawLayer. Kalau belum ada
        // (dipakai di luar alur layer), pakai nilai ruang layar.
        const sp = this._layerSpace.valid ? this._layerSpace : null;
        const lw = sp ? sp.sizePx[0] : w;
        const lh = sp ? sp.sizePx[1] : h;
        if (u.acLayerSize) gl.uniform2f(u.acLayerSize, lw, lh);
        if (u.acScreenSize) gl.uniform2f(u.acScreenSize, w, h);
        if (u.acLayerCenter) gl.uniform2f(u.acLayerCenter, sp ? sp.centerPx[0] : w / 2, sp ? sp.centerPx[1] : h / 2);
        if (u.acLayerCenterNorm) gl.uniform2f(u.acLayerCenterNorm, sp ? sp.centerNorm[0] : 0.5, sp ? sp.centerNorm[1] : 0.5);
        if (u.acLayerSizeNorm) gl.uniform2f(u.acLayerSizeNorm, sp ? sp.sizeNorm[0] : 1, sp ? sp.sizeNorm[1] : 1);
        if (u.acLayerPivot) gl.uniform2f(u.acLayerPivot, 0, 0);
        if (u.acPreviewSize) gl.uniform2f(u.acPreviewSize, w, h);
        if (u.acProjectSize) gl.uniform2f(u.acProjectSize, w, h);
        if (u.acPass) gl.uniform1i(u.acPass, passIndex);
        if (u.acTime) gl.uniform1f(u.acTime, localSeconds);
        // Kecepatan animasi layer (dipakai efek motion blur). acVelocity dalam
        // piksel frame terakhir, acAngularVelocity derajat/frame.
        if (u.acAngularVelocity) gl.uniform1f(u.acAngularVelocity, vel ? vel.angle : 0);
        if (u.acVelocity) gl.uniform2f(u.acVelocity, vel ? vel.x * velScale : 0, vel ? vel.y * velScale : 0);
        if (u.acScaleVelocity) gl.uniform1f(u.acScaleVelocity, vel ? vel.scale : 0);
        if (u.acShowGuides) gl.uniform1i(u.acShowGuides, 0);
        if (u.acLayerToScreen) gl.uniformMatrix4fv(u.acLayerToScreen, false, sp ? sp.toScreen : IDENTITY_MAT4);
        if (u.acScreenToLayer) gl.uniformMatrix4fv(u.acScreenToLayer, false, sp ? sp.toLayer : IDENTITY_MAT4);
    }

    /**
     * Daftar binding (uniform + channel keyframe) untuk satu instance efek.
     * Dibuat sekali per instance; dulu tiap frame memanggil params.find() dan
     * mengalokasi array baru untuk setiap parameter.
     */
    _planFor(instance, entry) {
        // Cache disimpan di entry (per program/group): lokasi uniform beda antar
        // group, tapi tiap instance tetap cuma dihitung sekali per group.
        const cache = entry._plans || (entry._plans = new WeakMap());
        const cached = cache.get(instance);
        if (cached) return cached;

        const items = [];
        for (const param of entry.definition.params) {
            const name = entry.uniformNames.get(param.id) || param.id;
            const override = instance.params.find((p) => p.id === param.id);
            if (param.type === 'texture') {
                items.push({
                    id: param.id, type: 'texture',
                    comp: param.srcType === 'comp',
                    uniform: entry.uniforms[`u_${name}_texture`] || null,
                    sizeUniform: entry.uniforms[`u_${name}_size`] || null
                });
                continue;
            }
            items.push({
                id: param.id,
                type: param.type,
                kind: GLSL_TYPE_FOR_PARAM[param.type] || null,
                loc: entry.uniforms[name] || null,
                channel: override ? override.channel : null,
                fallback: param.defaultValue
            });
        }
        const plan = { entry, items };
        cache.set(instance, plan);
        instance._paramObj = null;   // bentuk param bisa berubah setelah compile ulang
        return plan;
    }

    _bindEffectParams(entry, instance, u, textures, w, h, boxW, boxH) {
        const gl = this.gl;
        const items = this._planFor(instance, entry).items;
        const vec = this._paramScratch;
        let unit = 0;

        for (const item of items) {
            if (item.type === 'texture') {
                const source = item.comp ? textures.comp : textures.input;
                gl.activeTexture(gl.TEXTURE0 + unit);
                gl.bindTexture(gl.TEXTURE_2D, source || this.placeholderTexture);
                if (item.uniform) gl.uniform1i(item.uniform, unit);
                // inputImg = tekstur layer (di AM seukuran kotak layer), comp =
                // tekstur scene (seukuran layar). Efek memakai getTexSize(inputImg.size)
                // untuk ukuran texel & rasio aspek kotak layer, jadi jangan pakai w,h.
                if (item.sizeUniform) {
                    if (item.comp) gl.uniform2f(item.sizeUniform, w, h);
                    else gl.uniform2f(item.sizeUniform, boxW || w, boxH || h);
                }
                unit++;
                continue;
            }

            const kind = item.kind;
            const loc = item.loc;
            if (!loc || !kind) continue;

            const value = item.channel ? evalChannelInto(item.channel, u, vec) : item.fallback;
            const scalar = Array.isArray(value) ? value[0] : value;

            if (kind === 'float') gl.uniform1f(loc, Number.isFinite(scalar) ? scalar : 0);
            else if (kind === 'bool') gl.uniform1i(loc, scalar ? 1 : 0);
            else if (kind === 'int') gl.uniform1i(loc, Math.round(Number.isFinite(scalar) ? scalar : 0));
            else if (kind === 'vec2') gl.uniform2f(loc, value[0] || 0, value[1] || 0);
            else if (kind === 'vec3') gl.uniform3f(loc, value[0] || 0, value[1] || 0, value[2] || 0);
            else if (kind === 'vec4') gl.uniform4f(loc, value[0] || 0, value[1] || 0, value[2] || 0, value[3] === undefined ? 1 : value[3]);
            else if (kind === 'mat4') {
                if (value.length === 16) {
                    this._matScratch.set(value);
                    gl.uniformMatrix4fv(loc, false, this._matScratch);
                } else {
                    gl.uniformMatrix4fv(loc, false, IDENTITY_MAT4);
                }
            }
        }
    }

    _runChain(layer, u, localSeconds, w, h, vel) {
        const gl = this.gl;
        const targets = this._targetsFor(w, h);
        let source = targets.a.tex;
        let target = targets.b;
        // Posisi layer ditulis dalam koordinat scene; uniform acScreenSize pakai
        // ukuran target render, jadi kecepatannya ikut diskalakan.
        const velScale = this.scene && this.scene.height ? h / this.scene.height : 1;

        this._upload(this.raster, targets.a, w, h);
        if (!this.effectsEnabled) return targets.a.tex;
        gl.disable(gl.BLEND);

        for (const instance of layer.effects) {
            const entry = this.programs.get(instance.id);
            if (!entry || !entry.programsByGroup) continue;
            // Animator boleh memilih group (mis. motion blur hanya kalau layer
            // bergerak); null = belum ada pendapat -> pakai group pertama.
            const selected = instance._shaderGroups == null
                ? [entry.groupOrder[0]]
                : instance._shaderGroups;
            let passIdx = 0;
            for (const groupId of selected) {
                const pass = entry.programsByGroup.get(String(groupId));
                if (!pass) continue;
                gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
                gl.viewport(0, 0, w, h);
                gl.useProgram(pass.program);
                this._bindQuad(pass.attribs);
                this._standardUniforms(pass, localSeconds, w, h, vel, velScale, passIdx);
                this._texSlots.input = source;
                this._texSlots.comp = this.sceneTarget.tex;
                this._bindEffectParams(pass, instance, u, this._texSlots, w, h,
                    this._layerSpace.valid ? this._layerSpace.sizePx[0] : w,
                    this._layerSpace.valid ? this._layerSpace.sizePx[1] : h);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
                this.stats.passes++;
                passIdx++;
                source = target.tex;
                target = target === targets.a ? targets.b : targets.a;
            }
        }
        return source;
    }

    _blendFor(mode) {
        return BLEND_FACTORS[mode] || BLEND_FACTORS.normal;
    }

    // ----------------------------------------------------------------- drawing

    /** Layer transform + opacity after running the layer's JS animator effects. */
    _element(layer, u, localSeconds) {
        let pool = layer._elPool;
        if (!pool) {
            const el = createElementState('');
            pool = layer._elPool = {
                el,
                loc: el.transform.location,
                scale: el.transform.scale,
                env: {
                    time: 0, duration: 0, frame: 0, fps: 30, absTime: 0, inTime: 0,
                    velocity: { x: 0, y: 0 }, scaleVelocity: 0, angularVelocity: 0
                },
                vel: { x: 0, y: 0, scale: 0, angle: 0 },
                vec: [0, 0, 0, 0]
            };
        }
        const el = pool.el;
        const vec = pool.vec;
        // Animator boleh mengganti objek transform; pastikan tetap objek milik pool.
        if (el.transform.location !== pool.loc) el.transform.location = pool.loc;
        if (el.transform.scale !== pool.scale) el.transform.scale = pool.scale;

        evalChannelInto(layer.transform.location, u, vec);
        pool.loc.x = vec[0];
        pool.loc.y = vec[1];
        pool.loc.z = vec[2];
        evalChannelInto(layer.transform.scale, u, vec);
        pool.scale.x = vec[0];
        pool.scale.y = vec[1];
        el.alpha = evalScalar(layer.transform.opacity, u);
        el.transform.angle = evalScalar(layer.transform.rotation, u);
        // Group shader dipilih ulang oleh animator tiap frame.
        if (el.shaderGroups) el.shaderGroups = null;

        for (const instance of layer.effects) {
            const entry = this.programs.get(instance.id);
            if (!entry || !entry.animator) continue;
            try {
                const params = this._scriptParams(entry, instance, u);
                const env = pool.env;
                const fps = (this.scene && this.scene.fps) || 30;
                env.time = u;
                env.duration = (layer.endTime - layer.startTime) / 1000;
                env.frame = Math.round(localSeconds * fps);
                env.fps = fps;
                env.absTime = localSeconds;
                env.inTime = 0;
                // Kecepatan frame sebelumnya: motion blur memakainya untuk
                // menentukan group shader mana yang perlu jalan.
                const sw = (this.scene && this.scene.width) || 1;
                const sh = (this.scene && this.scene.height) || 1;
                env.velocity.x = pool.vel.x / sw;   // ternormalisasi, seperti AM
                env.velocity.y = pool.vel.y / sh;
                env.scaleVelocity = pool.vel.scale;
                env.angularVelocity = pool.vel.angle;
                const before = el.transform.angle;
                entry.animator.animate(env, el, params);
                if (instance._hasRpm === undefined) instance._hasRpm = instance.params.some((p) => p.id === 'rpm');
                if (instance._hasRpm && el.transform.angle !== before) {
                    const rpm = this._paramScalar(entry, instance, 'rpm', u);
                    el.transform.angle = before + rpm * localSeconds;
                }
                instance._shaderGroups = Array.isArray(el.shaderGroups) ? el.shaderGroups.map(String) : null;
                el.shaderGroups = null;
            } catch (e) {
                if (!layer._scriptError) {
                    layer._scriptError = true;
                    this.log(`[SCENE] Script ${instance.id} gagal: ${e.message}`);
                }
            }
        }
        // Kecepatan transform per frame (px, derajat, delta skala) untuk motion
        // blur. dt di luar rentang wajar (seek/lag) -> 0 supaya tidak meledak.
        this._measureVelocity(layer, pool, el.transform.angle, localSeconds);
        el._velocity = pool.vel;
        return el;
    }

    _measureVelocity(layer, pool, angle, localSeconds) {
        const vel = pool.vel;
        const prev = layer._prevXf || (layer._prevXf = { t: NaN, x: 0, y: 0, sx: 0, a: 0 });
        const timeMs = layer.startTime + localSeconds * 1000;
        const nominal = 1000 / ((this.scene && this.scene.fps) || 30);
        const dt = timeMs - prev.t;
        if (prev.t === prev.t && dt >= nominal * 0.25 && dt <= nominal * 4) {
            vel.x = pool.loc.x - prev.x;
            vel.y = pool.loc.y - prev.y;
            vel.scale = pool.scale.x - prev.sx;
            vel.angle = angle - prev.a;
        } else {
            vel.x = 0; vel.y = 0; vel.scale = 0; vel.angle = 0;
        }
        prev.t = timeMs;
        prev.x = pool.loc.x;
        prev.y = pool.loc.y;
        prev.sx = pool.scale.x;
        prev.a = angle;
    }

    _paramScalar(entry, instance, id, u) {
        for (const item of this._planFor(instance, entry).items) {
            if (item.id !== id || item.type === 'texture') continue;
            if (!item.channel) return item.fallback;
            return evalChannelInto(item.channel, u, this._paramScratch)[0] || 0;
        }
        return 0;
    }

    /** Parameter untuk animator JS; objeknya dipakai ulang tiap frame. */
    _scriptParams(entry, instance, u) {
        const items = this._planFor(instance, entry).items;
        const p = instance._paramObj || (instance._paramObj = {});
        const vec = this._paramScratch;
        for (const item of items) {
            const type = item.type;
            if (type === 'texture' || type === 'tip') continue;
            const value = item.channel ? evalChannelInto(item.channel, u, vec) : item.fallback;
            let slot = p[item.id];
            if (type === 'point') {
                if (!slot || typeof slot !== 'object') slot = p[item.id] = { x: 0, y: 0 };
                slot.x = value[0];
                slot.y = value[1];
            } else if (type === 'xyz') {
                if (!slot || typeof slot !== 'object' || slot.z === undefined) slot = p[item.id] = { x: 0, y: 0, z: 0 };
                slot.x = value[0];
                slot.y = value[1];
                slot.z = value[2];
            } else if (type === 'color') {
                if (!slot || typeof slot !== 'object') slot = p[item.id] = { r: 0, g: 0, b: 0, a: 1 };
                slot.r = value[0];
                slot.g = value[1];
                slot.b = value[2];
                slot.a = value[3] === undefined ? 1 : value[3];
            } else if (type === 'switch') {
                p[item.id] = !!value[0];
            } else {
                p[item.id] = Array.isArray(value) ? value[0] : value;
            }
        }
        return p;
    }

    /** Rantai transform dari parent paling atas sampai layer itu sendiri. */
    _transformChain(layer, timeMs) {
        const chain = [layer];
        let node = layer.parentLayer;
        let guard = 0;
        while (node && guard++ < 16) {
            chain.push(node);
            node = node.parentLayer;
        }
        chain.reverse();
        if (chain.length === 1) return null;   // tidak ada parent -> jalur cepat
        return chain;
    }

    /** Transform parent (nullobj/group) dievaluasi di waktu scene; di luar
     *  window-nya keyframe ditahan seperti AM. */
    _parentU(layer, timeMs) {
        const span = layer.endTime - layer.startTime;
        if (span <= 0) return 0;
        const u = (timeMs - layer.startTime) / span;
        return u < 0 ? 0 : (u > 1 ? 1 : u);
    }

    _layerU(layer, timeMs) {
        if (timeMs < layer.startTime || timeMs > layer.endTime) return null;
        const span = layer.endTime - layer.startTime;
        return span > 0 ? (timeMs - layer.startTime) / span : 0;
    }

    _drawLayer(layer, u, localSeconds) {
        if (layer._hidden) return;
        const scene = this.scene;
        if (layer.fillVideo && !layer.fillImage) {
            // Isi layer ini video (mp4 internal AM) yang belum bisa kita decode.
            if (!layer._videoSkipped) {
                layer._videoSkipped = true;
                this.log(`[SCENE] Layer ${layer.id} pakai fillVideo (mp4) - belum didukung, layer dilewati.`);
            }
            return;
        }
        const el = this._element(layer, u, localSeconds);
        const alpha = Math.max(0, Math.min(1, el.alpha));
        // Layer transparan tidak perlu di-raster sama sekali.
        if (alpha <= 0.002) return;

        const size = this._contentSize(layer, scene);
        const k = this.workHeight / scene.height;
        const ctx = this.rasterCtx;

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.workWidth, this.workHeight);
        ctx.save();
        const matrix = this._applyTransforms(ctx, layer, el, k, localSeconds);
        layer._scene = scene;
        layer._subTimeMs = localSeconds * 1000;
        layer._subSpanMs = layer.endTime - layer.startTime;
        const px = this._contentPx(layer, size);
        buildLayerSpace(this._layerSpace, matrix, px[0], px[1], this.workWidth, this.workHeight);
        this._rasterizeLayer(layer, size, ctx);
        ctx.restore();

        const layerAlpha = Math.max(0, Math.min(1, el.alpha * this._parentAlpha(layer, localSeconds)));
        if (layerAlpha <= 0.002) return;

        const texture = this._runChain(layer, u, localSeconds, this.workWidth, this.workHeight, el._velocity);

        const gl = this.gl;
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneTarget.fbo);
        gl.viewport(0, 0, this.workWidth, this.workHeight);
        gl.enable(gl.BLEND);
        const blend = this._blendFor(layer.blendMode);
        gl.blendFunc(blend[0], blend[1]);
        gl.useProgram(this.blitProgram);
        this._bindQuad(this.blitAttribs);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        if (this.blitUniforms.u_image) gl.uniform1i(this.blitUniforms.u_image, 0);
        if (this.blitUniforms.u_alpha) gl.uniform1f(this.blitUniforms.u_alpha, layerAlpha);
        if (this.blitUniforms.u_transform) gl.uniformMatrix3fv(this.blitUniforms.u_transform, false, IDENTITY_MAT3);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        gl.disable(gl.BLEND);
    }

    /**
     * Terapkan transform parent (kalau ada) lalu transform layer. Layer anak
     * memakai ruang koordinat parent, jadi urutannya: parent dulu, baru anak.
     */
    _applyTransforms(ctx, layer, el, k, localSeconds) {
        const chain = this._transformChain(layer);
        if (!chain) {
            this._applyOneTransform(ctx, el, k, MAT_ACC);
            return MAT_ACC;
        }
        MAT_ACC[0] = 1; MAT_ACC[1] = 0; MAT_ACC[2] = 0;
        MAT_ACC[3] = 1; MAT_ACC[4] = 0; MAT_ACC[5] = 0;
        const timeMs = layer.startTime + localSeconds * 1000;
        for (const node of chain) {
            const el2 = node === layer
                ? el
                : this._element(node, this._parentU(node, timeMs), (timeMs - node.startTime) / 1000);
            this._applyOneTransform(ctx, el2, k, MAT_NODE);
            mat2x3MulInto(MAT_ACC, MAT_ACC, MAT_NODE);
        }
        return MAT_ACC;
    }

    /** Terapkan satu transform ke ctx dan kembalikan matriksnya lewat argumen out. */
    _applyOneTransform(ctx, el, k, out) {
        const t = el.transform;
        const tx = t.location.x * k;
        const ty = t.location.y * k;
        const sx = t.scale.x || 1e-4;
        const sy = t.scale.y || 1e-4;
        const rad = (t.angle * Math.PI) / 180;
        const cs = Math.cos(rad);
        const sn = Math.sin(rad);
        ctx.translate(tx, ty);
        if (t.angle) ctx.rotate(rad);
        ctx.scale(sx, sy);
        if (out) {
            out[0] = cs * sx; out[1] = sn * sx;
            out[2] = -sn * sy; out[3] = cs * sy;
            out[4] = tx; out[5] = ty;
        }
        return out;
    }

    /** Opacity parent menurun ke anak (nullobj transparan = anak transparan). */
    _parentAlpha(layer, localSeconds) {
        let node = layer.parentLayer;
        let alpha = 1;
        let guard = 0;
        while (node && guard++ < 16) {
            const timeMs = layer.startTime + localSeconds * 1000;
            const el = this._element(node, this._parentU(node, timeMs), (timeMs - node.startTime) / 1000);
            alpha *= el.alpha;
            node = node.parentLayer;
        }
        return alpha;
    }

    renderAt(timeMs) {
        if (!this.scene) return;
        const gl = this.gl;
        this.workWidth = this.baseWidth;
        this.workHeight = this.baseHeight;
        this.timeMs = timeMs;
        this.stats = { layers: 0, passes: 0 };

        this.sceneTarget = this._targetsFor(this.workWidth, this.workHeight, 'scene:').a;

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.sceneTarget.fbo);
        gl.viewport(0, 0, this.workWidth, this.workHeight);
        gl.disable(gl.BLEND);
        const bg = this.scene.bgcolor;
        gl.clearColor(bg[0], bg[1], bg[2], bg[3]);
        gl.clear(gl.COLOR_BUFFER_BIT);

        for (const layer of this.scene.layers) {
            if (this.hiddenLayers && this.hiddenLayers.has(layer.id)) continue;
            const u = this._layerU(layer, timeMs);
            if (u === null) continue;
            this.stats.layers++;
            this._drawLayer(layer, u, (timeMs - layer.startTime) / 1000);
        }

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.workWidth, this.workHeight);
        gl.disable(gl.BLEND);
        gl.useProgram(this.blitProgram);
        this._bindQuad(this.blitAttribs);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.sceneTarget.tex);
        if (this.blitUniforms.u_image) gl.uniform1i(this.blitUniforms.u_image, 0);
        if (this.blitUniforms.u_alpha) gl.uniform1f(this.blitUniforms.u_alpha, 1);
        if (this.blitUniforms.u_transform) gl.uniformMatrix3fv(this.blitUniforms.u_transform, false, IDENTITY_MAT3);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
}
