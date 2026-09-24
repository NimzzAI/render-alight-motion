/**
 * Alight Motion WebGL Renderer & Effect Controller
 */
import {
    buildFragmentShaderSource,
    buildVertexShaderSource,
    getUniformNames,
    buildPlainVertexShader,
    buildPlainFragmentShader
} from './gl-runtime.js';
import {
    createScriptAnimator,
    createElementState,
    buildScriptEnv,
    buildScriptParams
} from './script-runtime.js';

export class EffectRenderer {
    constructor(canvas, logCallback = console.log) {
        this.canvas = canvas;
        // Alight Motion shaders are written for GLSL ES 3.00 semantics (int
        // overloads, dynamic loops), so prefer WebGL2 and only fall back to
        // WebGL1/ES 1.00 when unavailable.
        this.gl2 = canvas.getContext('webgl2') || null;
        this.gl = this.gl2
            || canvas.getContext('webgl', { preserveDrawingBuffer: true })
            || canvas.getContext('experimental-webgl');
        if (!this.gl) {
            throw new Error('WebGL not supported');
        }
        this.webglVersion = this.gl2 ? 2 : 1;
        this.log = logCallback;
        this.log(`[WEBGL] Backend: WebGL${this.webglVersion} (GLSL ES ${this.webglVersion >= 2 ? '3.00' : '1.00'})`);
        if (this.webglVersion < 2) {
            this.log('[WEBGL] WebGL2 tidak tersedia; sebagian efek (loop dinamis / min-max integer) bisa gagal dikompilasi.');
        }

        this.currentEffect = null;
        this.program = null;
        this.uniformLocations = {};
        this.attribLocations = {};

        this.paramValues = {};
        this.inputTexture = null;
        this.inputImageSize = [512, 512];

        this.animationFrameId = null;
        this.startTime = performance.now();

        this.initGL();
    }

    initGL() {
        const gl = this.gl;

        // Create standard fullscreen quad buffer
        this.positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        // 2 Triangles covering clip space [-1, 1]
        const positions = new Float32Array([
            -1, -1,
             1, -1,
            -1,  1,
            -1,  1,
             1, -1,
             1,  1,
        ]);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

        this.texCoordBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
        // TexCoords [0, 1] matching clip-space (-1..1)
        const texCoords = new Float32Array([
            0, 0,
            1, 0,
            0, 1,
            0, 1,
            1, 0,
            1, 1,
        ]);
        gl.bufferData(gl.ARRAY_BUFFER, texCoords, gl.STATIC_DRAW);

        // Default placeholder 1x1 white texture
        this.placeholderTexture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.placeholderTexture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
        this.inputTexture = this.placeholderTexture;
    }

    loadEffect(effect) {
        this.log(`[XML] Loading effect: ${effect.name || effect.id}`);

        // Build & compile first. If this throws, the previous effect (program,
        // params and UI) must stay untouched, otherwise the old program keeps
        // rendering while the new params are set -> sliders look dead.
        let animator = null;

        if (effect.shader) {
            const shaderOptions = { webglVersion: this.webglVersion };
            const fsSource = buildFragmentShaderSource(effect, this.log, shaderOptions);
            const vsSource = buildVertexShaderSource(effect, this.log, shaderOptions);
            this.compileProgram(vsSource, fsSource);
            this.mode = 'shader';
        } else if (effect.script && effect.script.code) {
            // Not a pixel shader: the script animates layer properties
            animator = createScriptAnimator(effect, this.log);
            this.compileProgram(
                buildPlainVertexShader(this.webglVersion),
                buildPlainFragmentShader(this.webglVersion)
            );
            this.mode = 'script';
            this.lastScriptText = null;
            // Text effects rewrite el.text; there is no text layer in the preview,
            // so a sample string is used and the result is written to the log.
            this.scriptSampleText = /el\.text/.test(effect.script.code) ? 'Sample 1234.5' : '';
            this.log('[SCRIPT] Efek animator properti: alpha/posisi/scale/rotasi diterapkan ke gambar.');
            if (this.scriptSampleText) {
                this.log(`[SCRIPT] Efek ini mengubah teks layer; contoh teks yang dipakai: ${JSON.stringify(this.scriptSampleText)}`);
            }
        } else if (effect.script && effect.script.external) {
            throw new Error(`Efek ${effect.id} memakai script bawaan Alight Motion (${effect.script.external}) yang jalan native di aplikasi, jadi belum bisa dipreview di web.`);
        } else {
            throw new Error(`Efek ${effect.id} diimplementasikan native di Alight Motion (bukan shader/script), jadi belum bisa dipreview di web.`);
        }

        // Initialize param values with default values
        const paramValues = {};
        for (const param of effect.params) {
            paramValues[param.id] = structuredClone(param.defaultValue);
            this.log(`[PARAM] Initialized ${param.id} = ${JSON.stringify(paramValues[param.id])}`);
        }

        this.currentEffect = effect;
        this.paramValues = paramValues;
        this.scriptAnimator = animator;
        // Params that clash with GLSL keywords/builtins are renamed in the shader
        this.uniformNames = getUniformNames(effect);

        this.log(`[SHADER] Successfully loaded effect ${effect.id}`);
    }

    compileProgram(vsSource, fsSource) {
        const gl = this.gl;
        this.log(`[SHADER] Compiling vertex and fragment shaders...`);

        const vs = this.createShader(gl.VERTEX_SHADER, vsSource);
        const fs = this.createShader(gl.FRAGMENT_SHADER, fsSource);

        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);

        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const info = gl.getProgramInfoLog(program);
            gl.deleteProgram(program);
            throw new Error(`Shader Link Error:\n${info}\n\nFragment Shader Code:\n${fsSource}`);
        }

        // Cache attribute and uniform locations
        this.attribLocations = {
            a_position: gl.getAttribLocation(program, 'a_position'),
            a_texCoord: gl.getAttribLocation(program, 'a_texCoord')
        };

        this.uniformLocations = {};
        const numUniforms = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
        for (let i = 0; i < numUniforms; i++) {
            const info = gl.getActiveUniform(program, i);
            if (info) {
                this.uniformLocations[info.name] = gl.getUniformLocation(program, info.name);
            }
        }

        const previousProgram = this.program;
        this.program = program;
        if (previousProgram) gl.deleteProgram(previousProgram);

        this.log(`[SHADER] Shader compiled & linked successfully.`);
        return program;
    }

    createShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            const info = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error(`Shader Compile Error (${type === gl.VERTEX_SHADER ? 'Vertex' : 'Fragment'}):\n${info}\n\nSource:\n${source}`);
        }
        return shader;
    }

    setInputImage(imgOrCanvas) {
        const gl = this.gl;
        
        // Render image onto a 512x512 power-of-two canvas to guarantee WebGL 1.0 GL_REPEAT works!
        const potCanvas = document.createElement('canvas');
        potCanvas.width = 512;
        potCanvas.height = 512;
        const ctx = potCanvas.getContext('2d');
        ctx.drawImage(imgOrCanvas, 0, 0, 512, 512);

        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, potCanvas);

        this.inputTexture = tex;
        this.inputImageSize = [512, 512];
        this.log(`[WEBGL] Updated input texture size to POT canvas: 512x512`);
    }

    setParamValue(id, val) {
        this.paramValues[id] = val;
        this.log(`[PARAM] ${id} = ${JSON.stringify(val)}`);
    }

    startRenderLoop() {
        if (this.animationFrameId) cancelAnimationFrame(this.animationFrameId);

        const render = (now) => {
            try {
                this.renderFrame(now);
                this.lastRenderError = null;
            } catch (e) {
                const msg = `${e.name}: ${e.message}`;
                if (this.lastRenderError !== msg) {
                    this.lastRenderError = msg;
                    this.log(`[ERROR] Render failed: ${msg}`);
                }
            }
            this.animationFrameId = requestAnimationFrame(render);
        };
        this.animationFrameId = requestAnimationFrame(render);
        this.log(`[WEBGL] Started animation render loop.`);
    }

    stopRenderLoop() {
        if (this.animationFrameId) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
    }

    renderFrame(nowTime) {
        if (!this.program || !this.currentEffect) return;

        if (this.mode === 'script') {
            this.renderScriptFrame(nowTime);
            return;
        }

        const gl = this.gl;
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(this.program);

        this.bindQuadAttributes();

        // Set Alight Motion Standard Uniforms
        const layerW = this.canvas.width;
        const layerH = this.canvas.height;
        const elapsedTime = (nowTime - this.startTime) / 1000.0;

        this.setUniform2f('acLayerNorm', 1.0, 1.0); // Normalised coord context inside layer
        this.setUniform2f('acLayerSize', layerW, layerH);
        this.setUniform2f('acScreenNorm', 1.0, 1.0);
        this.setUniform2f('acScreenSize', layerW, layerH);
        this.setUniform2f('acLayerCenter', layerW * 0.5, layerH * 0.5);
        this.setUniform2f('acLayerCenterNorm', 0.5, 0.5);
        this.setUniform2f('acLayerSizeNorm', 1.0, 1.0);
        this.setUniform2f('acLayerPivot', 0.0, 0.0);
        this.setUniform2f('acPreviewSize', layerW, layerH);
        this.setUniform2f('acProjectSize', layerW, layerH);
        this.setUniform1i('acPass', 0);
        this.setUniform1f('acTime', elapsedTime);
        this.setUniform1f('acAngularVelocity', 0.0);
        this.setUniform1i('acShowGuides', 0);

        // acLayerToScreen Identity Matrix (4x4)
        const identityMat4 = new Float32Array([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            0, 0, 0, 1
        ]);
        const uLayerToScreenLoc = this.uniformLocations['acLayerToScreen'];
        if (uLayerToScreenLoc) gl.uniformMatrix4fv(uLayerToScreenLoc, false, identityMat4);

        const uScreenToLayerLoc = this.uniformLocations['acScreenToLayer'];
        if (uScreenToLayerLoc) gl.uniformMatrix4fv(uScreenToLayerLoc, false, identityMat4);

        // Bind parameters & textures
        let textureUnit = 0;
        const uniformNames = this.uniformNames || new Map();
        for (const param of this.currentEffect.params) {
            const val = this.paramValues[param.id];
            const uniformName = uniformNames.get(param.id) || param.id;

            if (param.type === 'texture') {
                gl.activeTexture(gl.TEXTURE0 + textureUnit);
                gl.bindTexture(gl.TEXTURE_2D, this.inputTexture);

                const uTexLoc = this.uniformLocations[`u_${param.id}_texture`];
                if (uTexLoc) gl.uniform1i(uTexLoc, textureUnit);

                const uSizeLoc = this.uniformLocations[`u_${param.id}_size`];
                if (uSizeLoc) gl.uniform2f(uSizeLoc, this.inputImageSize[0], this.inputImageSize[1]);

                textureUnit++;
            } else if (param.type === 'spinner' || param.type === 'slider' || param.type === 'float') {
                this.setUniform1f(uniformName, parseFloat(val));
            } else if (param.type === 'switch') {
                this.setUniform1i(uniformName, val ? 1 : 0);
            } else if (param.type === 'selector') {
                this.setUniform1i(uniformName, parseInt(val, 10) || 0);
            } else if (param.type === 'point') {
                if (Array.isArray(val)) this.setUniform2f(uniformName, val[0], val[1]);
            } else if (param.type === 'xyz' || param.type === 'hue-disc') {
                if (Array.isArray(val)) this.setUniform3f(uniformName, val[0], val[1], val[2]);
            } else if (param.type === 'color') {
                if (Array.isArray(val)) this.setUniform4f(uniformName, val[0], val[1], val[2], val[3]);
            } else if (param.type === 'orient') {
                if (Array.isArray(val) && val.length === 16) this.setUniformMatrix4fv(uniformName, val);
            }
        }

        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    bindQuadAttributes() {
        const gl = this.gl;

        const positionLoc = this.attribLocations.a_position;
        if (positionLoc >= 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
            gl.enableVertexAttribArray(positionLoc);
            gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
        }

        const texCoordLoc = this.attribLocations.a_texCoord;
        if (texCoordLoc >= 0) {
            gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
            gl.enableVertexAttribArray(texCoordLoc);
            gl.vertexAttribPointer(texCoordLoc, 2, gl.FLOAT, false, 0, 0);
        }
    }

    /** 2D transform (translate/rotate/scale, clip space) for script effects. */
    computeScriptTransform(element) {
        const angle = (element.transform.angle || 0) * Math.PI / 180.0;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        const sx = element.transform.scale.x;
        const sy = element.transform.scale.y;
        const tx = (element.transform.location.x || 0) * (2.0 / this.canvas.width);
        const ty = -(element.transform.location.y || 0) * (2.0 / this.canvas.height);

        // column-major mat3: translate * rotate * scale
        return new Float32Array([
            cos * sx, sin * sx, 0.0,
            -sin * sy, cos * sy, 0.0,
            tx, ty, 1.0
        ]);
    }

    renderScriptFrame(nowTime) {
        const gl = this.gl;
        const elapsed = (nowTime - this.startTime) / 1000.0;

        let element;
        try {
            element = createElementState(this.scriptSampleText || '');
            this.scriptAnimator.animate(buildScriptEnv(elapsed), element, buildScriptParams(this.currentEffect, this.paramValues));
            this.lastScriptError = null;
        } catch (e) {
            const message = e.name + ': ' + e.message;
            if (this.lastScriptError !== message) {
                this.lastScriptError = message;
                this.log('[ERROR] Script gagal: ' + message);
            }
            return;
        }

        if (typeof element.text === 'string' && element.text && element.text !== this.lastScriptText) {
            this.lastScriptText = element.text;
            this.log('[SCRIPT] el.text = ' + JSON.stringify(element.text));
        }

        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.clearColor(0.0, 0.0, 0.0, 1.0);
        gl.clear(gl.COLOR_BUFFER_BIT);

        gl.useProgram(this.program);
        this.bindQuadAttributes();

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.inputTexture);
        this.setUniform1i('u_image', 0);
        this.setUniform1f('u_alpha', Math.max(0.0, Math.min(1.0, element.alpha)));
        this.setUniformMatrix3fv('u_transform', this.computeScriptTransform(element));

        gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    setUniform1f(name, v) {
        const loc = this.uniformLocations[name];
        if (loc) this.gl.uniform1f(loc, v);
    }

    setUniform1i(name, v) {
        const loc = this.uniformLocations[name];
        if (loc) this.gl.uniform1i(loc, v);
    }

    setUniform2f(name, x, y) {
        const loc = this.uniformLocations[name];
        if (loc) this.gl.uniform2f(loc, x, y);
    }

    setUniform3f(name, x, y, z) {
        const loc = this.uniformLocations[name];
        if (loc) this.gl.uniform3f(loc, x, y, z);
    }

    setUniform4f(name, x, y, z, w) {
        const loc = this.uniformLocations[name];
        if (loc) this.gl.uniform4f(loc, x, y, z, w);
    }

    setUniformMatrix3fv(name, value) {
        const loc = this.uniformLocations[name];
        if (loc) this.gl.uniformMatrix3fv(loc, false, new Float32Array(value));
    }

    setUniformMatrix4fv(name, value) {
        const loc = this.uniformLocations[name];
        if (loc) this.gl.uniformMatrix4fv(loc, false, new Float32Array(value));
    }
}
