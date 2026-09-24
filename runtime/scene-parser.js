/**
 * Alight Motion scene (project) XML parser.
 *
 * A scene file is different from an effect file: it describes layers (shapes,
 * media fills, nested scenes), their transform keyframes, the effects applied to
 * each layer, and the audio track. Times in the file are milliseconds, while
 * keyframe `t` values are normalized to the *layer's own duration* and are
 * allowed to fall outside [0, 1] (AM keeps keyframes when a clip is trimmed).
 */

const EASING_CACHE = new Map();

/** Component count for scene <property type="..."> values. */
const SCENE_PROP_COMPONENTS = { vec2: 2, vec3: 3, vec4: 4 };

export function parseNumberList(str) {
    if (str === null || str === undefined) return [];
    return String(str)
        .trim()
        .split(/[,\s]+/)
        .map((v) => parseFloat(v))
        .filter((v) => !Number.isNaN(v));
}

/** Alight Motion stores colors as #AARRGGBB (or #RRGGBB). Returns 0..1 floats. */
export function parseColor(str) {
    if (!str) return [0, 0, 0, 1];
    let hex = String(str).trim().replace(/^#/, '');
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    if (hex.length === 6) hex = 'ff' + hex;
    if (hex.length !== 8) return [0, 0, 0, 1];
    const bytes = [0, 2, 4, 6].map((i) => parseInt(hex.substr(i, 2), 16) / 255);
    return [bytes[1], bytes[2], bytes[3], bytes[0]]; // rgba
}

function cubicBezierEasing(x1, y1, x2, y2) {
    const cx = 3 * x1;
    const bx = 3 * (x2 - x1) - cx;
    const ax = 1 - cx - bx;
    const cy = 3 * y1;
    const by = 3 * (y2 - y1) - cy;
    const ay = 1 - cy - by;
    const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
    const sampleY = (t) => ((ay * t + by) * t + cy) * t;
    const sampleDX = (t) => (3 * ax * t + 2 * bx) * t + cx;

    return (x) => {
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        let t = x;
        for (let i = 0; i < 8; i++) {
            const err = sampleX(t) - x;
            if (Math.abs(err) < 1e-5) return sampleY(t);
            const d = sampleDX(t);
            if (Math.abs(d) < 1e-6) break;
            t -= err / d;
        }
        let lo = 0;
        let hi = 1;
        t = x;
        for (let i = 0; i < 24; i++) {
            const err = sampleX(t) - x;
            if (Math.abs(err) < 1e-5) break;
            if (err > 0) hi = t; else lo = t;
            t = (lo + hi) / 2;
        }
        return sampleY(t);
    };
}

/**
 * Easing pegas (damped oscillation) untuk keluarga `elastic`/`reverse elastic`
 * dan `cyclic`. AM tidak menuliskan rumusnya di XML, jadi ini pendekatan yang
 * dijaga agar f(0)=0 dan f(1)=1 persis: osilasi teredam + koreksi ujung.
 */
function springEasing(amp, period, phase, reverse) {
    const A = Math.min(0.9, Math.max(0.05, Number.isFinite(amp) && amp > 0 ? amp : 0.5));
    const P = Number.isFinite(period) && period > 0.05 ? Math.min(4, period) : 1.0;
    const ph = Number.isFinite(phase) ? phase : 0;
    const lambda = (-2 * Math.log(A)) / P;
    const w = (2 * Math.PI) / P;
    const raw = (x) => 1 - Math.exp(-lambda * x) * Math.cos(w * x + ph * 2 * Math.PI);
    const start = raw(0);
    const end = raw(1);
    const f = (x) => {
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        return raw(x) + x * (1 - end) - (1 - x) * start;
    };
    return reverse ? (x) => 1 - f(1 - x) : f;
}

/**
 * `e="cubicBezier 0.42 0.0 0.58 1.0"`, `linear`, `elastic 0.5 1.0 0.0 1.0`,
 * `reverse elastic ...`, `cyclic ...`, atau `local cubicBezier ...` -> fn(t).
 *
 * PENTING: di XML Alight Motion, `e` ditempel pada keyframe AKHIR segmen
 * (easing "masuk"/incoming), bukan keyframe awal. Keyframe pertama tidak pernah
 * punya `e` dan keyframe terakhir hampir selalu punya, termasuk pada preset
 * bawaan AM seperti "Transition In: Fast". Karena itu evalChannelInto memakai
 * `kb.e`, bukan `ka.e`.
 */
export function easingFromString(str) {
    if (!str) return null;
    const key = String(str).trim();
    if (EASING_CACHE.has(key)) return EASING_CACHE.get(key);
    let fn = null;
    const parts = key.split(/\s+/);
    const family = parts[0] === 'local' ? parts[1] : parts[0];
    const reverse = family === 'reverse' && parts[1] === 'elastic';
    const name = reverse ? 'elastic' : family;
    const nums = parts.slice(reverse ? 2 : parts[0] === 'local' ? 2 : 1).map(parseFloat);
    const ok = (n) => nums.length >= n && nums.slice(0, n).every((v) => Number.isFinite(v));
    if (name === 'cubicBezier' && ok(4)) {
        fn = cubicBezierEasing(nums[0], nums[1], nums[2], nums[3]);
    } else if (name === 'elastic' && ok(3)) {
        fn = springEasing(nums[0], nums[1], nums[2], reverse);
    } else if (name === 'cyclic' && ok(1)) {
        // cyclic <amp> <...> <periode> ...: ambil angka positif pertama sesudah
        // amplitudo sebagai periode; default 2 osilasi per segmen (periode 0.5).
        const positif = nums.slice(1).find((v) => Number.isFinite(v) && v > 0.05 && v <= 4);
        fn = springEasing(nums[0], positif || 0.5, 0, false);
    }
    EASING_CACHE.set(key, fn);
    return fn;
}

function fitSize(values, size, fallback) {
    const out = [];
    for (let i = 0; i < size; i++) {
        const v = values[i];
        out.push(v === undefined ? (fallback[i] === undefined ? 0 : fallback[i]) : v);
    }
    return out;
}

function directChildren(node, tag) {
    if (!node || !node.children) return [];
    return Array.from(node.children).filter((c) => !tag || c.tagName === tag);
}

/**
 * Parses a <location>/<scale>/<rotation>/<opacity>/<property> node into a
 * channel: `{ value: number[], kfs: [{ t, v, e }] }`.
 */
export function parseChannel(node, size = 1, fallback = [0]) {
    const kfs = [];
    for (const kf of directChildren(node, 'kf')) {
        const t = parseFloat(kf.getAttribute('t'));
        if (Number.isNaN(t)) continue;
        const v = parseNumberList(kf.getAttribute('v'));
        kfs.push({ t, v: v.length ? v : [0], e: kf.getAttribute('e') || null });
    }
    kfs.sort((a, b) => a.t - b.t);

    const rawValue = parseNumberList(node.getAttribute('value'));
    let value;
    if (rawValue.length) value = rawValue;
    else if (kfs.length) value = kfs[0].v.slice();
    else value = fallback.slice();
    value = fitSize(value, size, fallback);

    const normalizedKfs = kfs.map((kf) => ({ ...kf, v: fitSize(kf.v, size, value) }));
    return { value, kfs: normalizedKfs };
}

/**
 * Evaluates a channel at u (layer-local normalized time). Values outside the
 * keyframe range hold the first/last keyframe, matching Alight Motion.
 */
export function evalChannel(channel, u) {
    return evalChannelInto(channel, u, []);
}

/**
 * Sama seperti evalChannel tapi menulis ke `out` tanpa alokasi baru (dipakai
 * di render loop supaya tidak menghasilkan sampah tiap frame).
 */
export function evalChannelInto(channel, u, out = [0, 0, 0, 0]) {
    if (!channel) { out[0] = 0; return out; }
    const kfs = channel.kfs;
    if (!kfs || !kfs.length) {
        const value = channel.value;
        for (let i = 0; i < value.length; i++) out[i] = value[i];
        return out;
    }

    let a = kfs[0];
    let b = null;
    let f = 0;
    if (u <= kfs[0].t) {
        a = kfs[0];
    } else if (u >= kfs[kfs.length - 1].t) {
        a = kfs[kfs.length - 1];
    } else {
        for (let i = 0; i < kfs.length - 1; i++) {
            const ka = kfs[i];
            const kb = kfs[i + 1];
            if (u < ka.t || u > kb.t) continue;
            a = ka;
            b = kb;
            const span = kb.t - ka.t;
            f = span > 1e-9 ? (u - ka.t) / span : 1;
            const ease = easingFromString(kb.e);
            if (ease) f = ease(f);
            break;
        }
    }

    for (let i = 0; i < a.v.length; i++) {
        const va = a.v[i];
        out[i] = b ? va + ((b.v[i] ?? va) - va) * f : va;
    }
    return out;
}

export function evalScalar(channel, u) {
    return evalChannel(channel, u)[0];
}

function parseEffect(node) {
    const params = [];
    for (const p of directChildren(node, 'property')) {
        const dataType = p.getAttribute('type');
        const raw = p.getAttribute('value');
        let channel;
        if (dataType === 'color') {
            channel = { value: parseColor(raw), kfs: [] };
        } else if (dataType === 'bool') {
            channel = { value: [raw === 'true' || raw === '1' ? 1 : 0], kfs: [] };
        } else {
            channel = parseChannel(p, SCENE_PROP_COMPONENTS[dataType] || 1, [0]);
        }
        params.push({ id: p.getAttribute('name'), dataType: dataType, channel: channel });
    }
    return {
        id: node.getAttribute('id') || '',
        shortId: (node.getAttribute('id') || '').split('.').pop(),
        locallyApplied: node.getAttribute('locallyApplied') !== 'false',
        params: params
    };
}

function parseTransform(node) {
    const t = {
        location: { value: [0, 0, 0], kfs: [] },
        scale: { value: [1, 1], kfs: [] },
        rotation: { value: [0], kfs: [] },
        opacity: { value: [1], kfs: [] }
    };
    if (!node) return t;
    for (const child of directChildren(node)) {
        switch (child.tagName) {
            case 'location': t.location = parseChannel(child, 3, [0, 0, 0]); break;
            case 'scale': t.scale = parseChannel(child, 2, [1, 1]); break;
            case 'rotation': t.rotation = parseChannel(child, 1, [0]); break;
            case 'opacity': t.opacity = parseChannel(child, 1, [1]); break;
            default: break;
        }
    }
    return t;
}

function parseGradient(node) {
    if (!node) return null;
    return {
        type: node.getAttribute('type') || 'linear',
        startColor: parseColor(node.getAttribute('startColor')),
        endColor: parseColor(node.getAttribute('endColor')),
        start: parseNumberList(node.getAttribute('start')),
        end: parseNumberList(node.getAttribute('end'))
    };
}

function parseSceneNode(sceneNode) {
    const scene = {
        title: sceneNode.getAttribute('title') || '',
        width: parseFloat(sceneNode.getAttribute('width')) || 1080,
        height: parseFloat(sceneNode.getAttribute('height')) || 1920,
        totalTime: parseFloat(sceneNode.getAttribute('totalTime')) || 0,
        fps: parseFloat(sceneNode.getAttribute('fps')) || 30,
        bgcolor: parseColor(sceneNode.getAttribute('bgcolor')),
        media: [],
        audio: [],
        bookmarks: [],
        layers: []
    };

    for (const child of directChildren(sceneNode)) {
        if (child.tagName === 'media') {
            scene.media.push({
                uri: child.getAttribute('uri') || '',
                type: child.getAttribute('type') || '',
                filename: child.getAttribute('filename') || '',
                title: child.getAttribute('title') || '',
                duration: parseFloat(child.getAttribute('duration')) || 0,
                width: parseFloat(child.getAttribute('width')) || 0,
                height: parseFloat(child.getAttribute('height')) || 0
            });
        } else if (child.tagName === 'audio') {
            scene.audio.push({
                id: child.getAttribute('id') || '',
                label: child.getAttribute('label') || '',
                src: child.getAttribute('src') || '',
                startTime: parseFloat(child.getAttribute('startTime')) || 0,
                endTime: parseFloat(child.getAttribute('endTime')) || 0,
                outTime: parseFloat(child.getAttribute('outTime')) || 0
            });
        } else if (child.tagName === 'bookmark') {
            scene.bookmarks.push(parseFloat(child.getAttribute('t')) || 0);
        } else if (LAYER_TAGS.has(child.tagName)) {
            scene.layers.push(parseLayerNode(child));
        }
    }
    return scene;
}

/** Tag yang diperlakukan sebagai layer. `nullobj` = container transform kosong. */
export const LAYER_TAGS = new Set(['shape', 'embedScene', 'group', 'text', 'nullobj', 'camera']);

function parseLayerNode(node) {
    const layer = {
        tag: node.tagName,
        id: node.getAttribute('id') || '',
        label: node.getAttribute('label') || '',
        startTime: parseFloat(node.getAttribute('startTime')) || 0,
        endTime: parseFloat(node.getAttribute('endTime')) || 0,
        fillType: node.getAttribute('fillType') || '',
        fillImage: node.getAttribute('fillImage') || '',
        fillVideo: node.getAttribute('fillVideo') || '',
        mediaFillMode: node.getAttribute('mediaFillMode') || 'fill',
        shapeType: (node.getAttribute('s') || '').trim(),
        cornerRadius: 0,
        parentId: node.getAttribute('parent') || '',
        parentLayer: null,
        // AM menulis mode blend di atribut `blending` (versi baru) atau `blendMode`.
        blendMode: node.getAttribute('blending') || node.getAttribute('blendMode') || 'normal',
        speed: parseFloat(node.getAttribute('speed')) || 1,
        outTime: parseFloat(node.getAttribute('outTime')) || 0,
        link: node.getAttribute('link') || '',
        // atribut `tag` AM (mis. "+orange"); JANGAN pakai nama `tag` karena
        // layer.tag dipakai untuk jenis elemen (shape/embedScene/nullobj).
        mediaTag: node.getAttribute('tag') || '',
        transform: { location: { value: [0, 0, 0], kfs: [] }, scale: { value: [1, 1], kfs: [] }, rotation: { value: [0], kfs: [] }, opacity: { value: [1], kfs: [] } },
        fillColor: [0, 0, 0, 1],
        gradient: null,
        size: { value: [100, 100], kfs: [] },
        effects: [],
        children: [],
        scene: null
    };
    if (layer.endTime <= layer.startTime) layer.endTime = layer.startTime + 1;

    for (const child of directChildren(node)) {
        switch (child.tagName) {
            case 'transform': layer.transform = parseTransform(child); break;
            case 'fillColor': layer.fillColor = parseColor(child.getAttribute('value')); break;
            case 'gradient': layer.gradient = parseGradient(child); break;
            case 'effect': layer.effects.push(parseEffect(child)); break;
            case 'property': {
                const name = child.getAttribute('name');
                if (name === 'size') layer.size = parseChannel(child, 2, [0, 0]);
                else if (name === 'cornerRadius') layer.cornerRadius = parseFloat(child.getAttribute('value')) || 0;
                else if (name === 'blendMode' || name === 'blending' || name === 'blend') {
                    const val = child.getAttribute('value');
                    if (val) layer.blendMode = val;
                }
                break;
            }
            case 'scene': layer.scene = parseSceneNode(child); break;
            default:
                if (layer.tag === 'group' && LAYER_TAGS.has(child.tagName)) {
                    layer.children.push(parseLayerNode(child));
                }
                break;
        }
    }
    return layer;
}

/** Parses an Alight Motion scene/project XML file. */
/**
 * Menyambungkan atribut `parent` ke layer-nya. Di AM, layer anak memakai
 * transform parent (biasanya <nullobj>) sebagai ruang koordinatnya, jadi tanpa
 * ini posisi anak bisa nyasar ke pojok kiri-atas.
 */
export function linkLayerParents(scene) {
    const byId = new Map();
    const collect = (node) => {
        for (const layer of node.layers || []) {
            if (layer.id) byId.set(layer.id, layer);
            collect(layer);
            if (layer.scene) collect(layer.scene);
        }
    };
    collect(scene);

    const assign = (node) => {
        for (const layer of node.layers || []) {
            if (layer.parentId) {
                const parent = byId.get(layer.parentId);
                if (parent && parent !== layer) layer.parentLayer = parent;
            }
            assign(layer);
            if (layer.scene) assign(layer.scene);
        }
    };
    assign(scene);

    // putus rantai melingkar (kalau XML-nya aneh)
    const all = [...byId.values()];
    for (const layer of all) {
        let guard = 0;
        let node = layer.parentLayer;
        while (node && guard++ < 64) {
            if (node === layer) { layer.parentLayer = null; break; }
            node = node.parentLayer;
        }
    }
    scene.layerById = byId;
    return byId;
}

export function parseSceneXML(xmlString, filename = '') {
    const doc = new DOMParser().parseFromString(xmlString, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) {
        throw new Error(`${filename}: XML tidak valid.`);
    }
    let sceneNode = doc.documentElement;
    if (!sceneNode || sceneNode.tagName !== 'scene') {
        sceneNode = doc.getElementsByTagName('scene')[0];
    }
    if (!sceneNode) throw new Error(`${filename}: tidak menemukan elemen <scene>.`);
    const scene = parseSceneNode(sceneNode);
    linkLayerParents(scene);
    scene.filename = filename;
    return scene;
}

/** Milliseconds -> keyframe u for a layer (can be outside [0,1]). */
export function layerLocalU(layer, timeMs) {
    const span = layer.endTime - layer.startTime;
    if (span <= 0) return 0;
    return (timeMs - layer.startTime) / span;
}
