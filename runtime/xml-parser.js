/**
 * XML Parser for Alight Motion Effect Files
 */

const MAT4_IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function parseNumbers(valStr, count) {
    const parts = String(valStr).split(',').map(p => parseFloat(p.trim()));
    const out = [];
    for (let i = 0; i < count; i++) {
        out.push(Number.isFinite(parts[i]) ? parts[i] : 0.0);
    }
    return out;
}

export function parseEffectXML(xmlString, filename = '') {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlString, 'text/xml');

    const parserError = xmlDoc.querySelector('parsererror');
    if (parserError) {
        throw new Error(`XML parsing error in ${filename}: ${parserError.textContent}`);
    }

    const effectNode = xmlDoc.querySelector('effect');
    if (!effectNode) {
        throw new Error(`No <effect> root tag found in ${filename}`);
    }

    const effect = {
        id: effectNode.getAttribute('id') || '',
        name: effectNode.getAttribute('name') || '',
        category: effectNode.getAttribute('category') || '',
        filename: filename,
        params: [],
        passes: [],
        shader: null,
        vertexShader: null,
        script: null
    };

    // Parse params
    const paramsNode = xmlDoc.querySelector('params');
    if (paramsNode) {
        for (const child of paramsNode.children) {
            const tagName = child.tagName.toLowerCase();

            // <section> is only a visual grouping and <tip> is a UI hint: neither is a parameter
            if (tagName === 'section' || tagName === 'tip') continue;

            const id = child.getAttribute('id');
            if (!id) continue;

            const defaultValue = child.getAttribute('default') ?? child.getAttribute('value');

            const param = {
                type: tagName, // texture, spinner, switch, selector, point, xyz, orient, color, hue-disc, float, ...
                id: id,
                label: child.getAttribute('label') || child.getAttribute('id'),
                srcType: child.getAttribute('srcType') || null,
                defaultValue: parseParamValue(defaultValue, tagName),
                min: child.getAttribute('min') !== null ? parseFloat(child.getAttribute('min')) : null,
                max: child.getAttribute('max') !== null ? parseFloat(child.getAttribute('max')) : null,
                step: child.getAttribute('step') !== null ? parseFloat(child.getAttribute('step')) : 0.01,
                valueType: child.getAttribute('type') || null, // e.g. "angle", "integer", "percent", "rotate"
                choices: []
            };

            // <selector> children carry the available options
            for (const choice of child.querySelectorAll('choice')) {
                param.choices.push({
                    label: choice.getAttribute('label') || choice.getAttribute('value'),
                    value: choice.getAttribute('value')
                });
            }

            effect.params.push(param);
        }
    }

    // Parse passes if present
    const passesNode = xmlDoc.querySelector('passes');
    if (passesNode) {
        for (const passNode of passesNode.querySelectorAll('pass')) {
            effect.passes.push({
                target: passNode.getAttribute('target') || null
            });
        }
    }

    // Satu efek bisa punya beberapa fragment shader ("group"), mis. motion blur
    // punya varian rotasi/skala/posisi. Animator memilih group mana yang jalan
    // lewat el.shaderGroups; tanpa itu dipakai group pertama.
    const shaderNodes = Array.from(xmlDoc.querySelectorAll('shader[type="fragment"]'));
    if (shaderNodes.length) {
        effect.shaders = shaderNodes.map((node) => ({
            type: 'fragment',
            group: node.getAttribute('group') || '0',
            precision: node.getAttribute('precision') || 'mediump',
            code: node.textContent.trim()
        }));
        effect.shader = effect.shaders[0];
    }

    // Parse optional JS animation effect (<script lang="js">) - these are not
    // pixel shaders but layer property animators.
    const scriptNodes = Array.from(xmlDoc.querySelectorAll('script'));
    if (scriptNodes.length) {
        let external = null;
        let lang = 'js';
        const chunks = [];
        for (const node of scriptNodes) {
            lang = node.getAttribute('lang') || lang;
            const ext = node.getAttribute('external');
            if (ext) {
                external = external || ext;
                continue;
            }
            const code = node.textContent.trim();
            if (code) chunks.push(code);
        }
        effect.script = {
            lang: lang,
            external: external,
            code: chunks.length ? chunks.join('\n\n') : null
        };
    }

    // Parse optional vertex shader (used by 3D effects)
    const vertexNode = xmlDoc.querySelector('shader[type="vertex"]');
    if (vertexNode) {
        effect.vertexShader = {
            type: 'vertex',
            precision: vertexNode.getAttribute('precision') || (effect.shader && effect.shader.precision) || 'mediump',
            code: vertexNode.textContent.trim()
        };
    }

    if (!effect.shader && !effect.script) {
        throw new Error(`Efek ${filename} tidak punya fragment shader maupun script.`);
    }

    return effect;
}

function parseParamValue(valStr, type) {
    if (valStr === null || valStr === undefined) {
        if (type === 'switch') return false;
        if (type === 'selector') return 0;
        if (type === 'point') return [0.0, 0.0];
        if (type === 'xyz') return [0.0, 0.0, 0.0];
        if (type === 'hue-disc') return [0.0, 1.0, 0.0];
        if (type === 'color') return [1.0, 1.0, 1.0, 1.0];
        if (type === 'orient') return MAT4_IDENTITY.slice();
        return 0.0;
    }

    if (type === 'switch') {
        return String(valStr).toLowerCase() === 'true';
    }

    if (type === 'selector') {
        const v = parseInt(valStr, 10);
        return Number.isFinite(v) ? v : 0;
    }

    if (type === 'point') {
        return parseNumbers(valStr, 2);
    }

    if (type === 'xyz') {
        return parseNumbers(valStr, 3);
    }

    if (type === 'hue-disc') {
        return parseNumbers(valStr, 3);
    }

    if (type === 'orient') {
        return MAT4_IDENTITY.slice();
    }

    if (type === 'color') {
        let hex = String(valStr).replace('#', '');
        if (hex.length === 8) {
            // Alight Motion uses #AARRGGBB
            const a = parseInt(hex.substring(0, 2), 16) / 255.0;
            const r = parseInt(hex.substring(2, 4), 16) / 255.0;
            const g = parseInt(hex.substring(4, 6), 16) / 255.0;
            const b = parseInt(hex.substring(6, 8), 16) / 255.0;
            return [r, g, b, a];
        } else if (hex.length === 6) {
            const r = parseInt(hex.substring(0, 2), 16) / 255.0;
            const g = parseInt(hex.substring(2, 4), 16) / 255.0;
            const b = parseInt(hex.substring(4, 6), 16) / 255.0;
            return [r, g, b, 1.0];
        }
        return [1.0, 1.0, 1.0, 1.0];
    }

    return parseFloat(valStr);
}
