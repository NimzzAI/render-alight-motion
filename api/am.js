// GET /api/am?url=<link alight motion>
// Balikin { ok, title, xml, projects:[{name,title}], media:[...], diag:[...] }
//
// Format paket Alight Motion TIDAK terdokumentasi resmi, jadi resolver ini
// mencoba beberapa strategi berurutan dan mengembalikan `diag` (log langkah)
// supaya kalau gagal kelihatan persis di mana -- bukan gagal diam-diam.

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const MAX_BYTES = 40 * 1024 * 1024;

function pickShareParts(u) {
    // https://alightcreative.com/am/share/u/<uid>/p/<pid>
    const m = u.pathname.match(/\/am\/share\/u\/([^/]+)\/p\/([^/?#]+)/);
    return m ? { uid: decodeURIComponent(m[1]), pid: decodeURIComponent(m[2]) } : null;
}

async function fetchBuf(url, opts = {}, diag, label) {
    const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': UA, ...(opts.headers || {}) } });
    diag.push(`${label}: HTTP ${res.status} ${res.headers.get('content-type') || ''}`);
    if (!res.ok) return { ok: false, status: res.status };
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) throw new Error(`paket terlalu besar (${(len / 1048576).toFixed(1)} MB)`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('paket terlalu besar');
    return { ok: true, buf, type: res.headers.get('content-type') || '' };
}

// ---- unzip minimal (tanpa dependency): baca central directory + inflateRaw ----
const zlib = require('zlib');

function readZip(buf) {
    // cari End Of Central Directory
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('bukan file zip');
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);
    const entries = [];
    for (let n = 0; n < count; n++) {
        if (buf.readUInt32LE(off) !== 0x02014b50) break;
        const method = buf.readUInt16LE(off + 10);
        const csize = buf.readUInt32LE(off + 20);
        const usize = buf.readUInt32LE(off + 24);
        const nlen = buf.readUInt16LE(off + 28);
        const elen = buf.readUInt16LE(off + 30);
        const clen = buf.readUInt16LE(off + 32);
        const lho = buf.readUInt32LE(off + 42);
        const name = buf.slice(off + 46, off + 46 + nlen).toString('utf8');
        entries.push({ name, method, csize, usize, lho });
        off += 46 + nlen + elen + clen;
    }
    const read = (e) => {
        const nlen = buf.readUInt16LE(e.lho + 26);
        const elen = buf.readUInt16LE(e.lho + 28);
        const start = e.lho + 30 + nlen + elen;
        const raw = buf.slice(start, start + e.csize);
        if (e.method === 0) return raw;
        if (e.method === 8) return zlib.inflateRawSync(raw);
        throw new Error(`metode kompresi ${e.method} tidak didukung`);
    };
    return { entries, read };
}

function looksLikeSceneXml(text) {
    return /<scene[\s>]/.test(text);
}

const MEDIA_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };
const AUDIO_MIME = { mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', wav: 'audio/wav', opus: 'audio/ogg' };

// Ekstrak project XML + gambar embed dari buffer zip.
function extractFromZip(buf, diag) {
    const zip = readZip(buf);
    diag.push(`zip: ${zip.entries.length} entri`);
    const projects = [];
    const media = [];
    const audio = [];
    for (const e of zip.entries) {
        if (e.name.endsWith('/')) continue;
        const lower = e.name.toLowerCase();
        const ext = lower.split('.').pop();
        if (ext === 'xml') {
            const text = zip.read(e).toString('utf8');
            if (looksLikeSceneXml(text)) {
                const title = (text.match(/<scene[^>]*\btitle="([^"]*)"/) || [])[1] || '';
                projects.push({ name: e.name, title, xml: text });
            }
        } else if (MEDIA_MIME[ext] && e.usize <= 6 * 1024 * 1024) {
            const data = zip.read(e);
            media.push({ name: e.name.split('/').pop(), path: e.name, mime: MEDIA_MIME[ext], data: data.toString('base64') });
        } else if (AUDIO_MIME[ext] && e.usize <= 25 * 1024 * 1024) {
            const data = zip.read(e);
            audio.push({ name: e.name.split('/').pop(), path: e.name, mime: AUDIO_MIME[ext], data: data.toString('base64') });
        }
    }
    return { projects, media, audio };
}

module.exports = async (req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('cache-control', 's-maxage=300, stale-while-revalidate=600');
    const diag = [];
    try {
        const raw = String(req.query.url || '').trim();
        if (!raw) return res.status(400).json({ ok: false, error: 'parameter url kosong', diag });
        let u;
        try { u = new URL(raw); } catch { return res.status(400).json({ ok: false, error: 'URL tidak valid', diag }); }
        const allowed = ['alightcreative.com', 'www.alightcreative.com', 'alight.link', 'www.alight.link', 'alightmotion.com', 'www.alightmotion.com'];
        if (!allowed.includes(u.hostname)) {
            return res.status(400).json({ ok: false, error: 'hanya link Alight Motion (alightcreative.com / alight.link)', diag });
        }

        // 1) ambil halaman share (alight.link biasanya redirect ke alightcreative.com/am/share/...)
        const page = await fetchBuf(u.toString(), {}, diag, 'halaman share');
        if (!page.ok) return res.status(502).json({ ok: false, error: `halaman share HTTP ${page.status}`, diag });
        const html = page.buf.toString('utf8');
        const parts = pickShareParts(u) || (() => {
            const m = html.match(/\/am\/share\/u\/([^/"'\s]+)\/p\/([^/"'\s?#]+)/);
            return m ? { uid: m[1], pid: m[2] } : null;
        })();
        if (!parts) return res.status(422).json({ ok: false, error: 'uid/pid tidak ketemu di link', diag });
        diag.push(`uid=${parts.uid} pid=${parts.pid}`);

        const title = (html.match(/property="og:title"\s+content="([^"]*)"/) || html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
        const sizeInfo = (html.match(/contains (\d+) project[s]?, total ([\d.]+ ?(?:MB|kb|KB|GB))/i) || []);
        diag.push(`meta: ${sizeInfo[1] || '?'} project, ${sizeInfo[2] || '?'}`);

        // 2) token thumbnail menunjukkan bucket + prefix path yang valid
        const thumb = html.match(/https:\/\/firebasestorage\.googleapis\.com\/v0\/b\/([^/]+)\/o\/([^?"'\s]+)/);
        const bucket = thumb ? thumb[1] : 'alight-creative.appspot.com';
        const base = `share/u/${parts.uid}/p/${parts.pid}/`;
        diag.push(`bucket=${bucket}`);

        // 3) coba list objek di prefix itu (Firebase Storage REST), lalu kandidat nama file
        let objectNames = [];
        const listUrl = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o?prefix=${encodeURIComponent(base)}&delimiter=%2F`;
        try {
            const l = await fetchBuf(listUrl, {}, diag, 'list objek');
            if (l.ok) {
                const j = JSON.parse(l.buf.toString('utf8'));
                objectNames = (j.items || []).map((i) => i.name);
                diag.push(`objek: ${objectNames.map((n) => n.replace(base, '')).join(', ') || '(kosong)'}`);
            }
        } catch (e) { diag.push(`list objek gagal: ${e.message}`); }

        const candidates = [
            ...objectNames.filter((n) => /\.(zip|xml|alightmotion|alightlink)$/i.test(n) || /package|project|optimi/i.test(n)),
            ...['package.zip', 'project.zip', 'optimized.zip', 'package', 'project.xml', 'project'].map((n) => base + n)
        ];
        const seen = new Set();
        let found = null;
        for (const name of candidates) {
            if (seen.has(name)) continue;
            seen.add(name);
            const url = `https://firebasestorage.googleapis.com/v0/b/${bucket}/o/${encodeURIComponent(name)}?alt=media`;
            let r;
            try { r = await fetchBuf(url, {}, diag, `coba ${name.replace(base, '')}`); } catch (e) { diag.push(`  ${e.message}`); continue; }
            if (!r.ok) continue;
            found = { name, buf: r.buf };
            break;
        }
        if (!found) {
            return res.status(422).json({
                ok: false,
                error: 'file paket nggak ketemu di penyimpanan Alight Motion. Format share link mungkin berubah / butuh auth. Pakai tombol "Upload XML" sebagai gantinya.',
                title, diag
            });
        }

        // 4) isi: zip atau xml polos
        const head = found.buf.slice(0, 4);
        let projects = [];
        let media = [];
        let audio = [];
        if (head[0] === 0x50 && head[1] === 0x4b) {
            ({ projects, media, audio } = extractFromZip(found.buf, diag));
        } else {
            const text = found.buf.toString('utf8');
            if (looksLikeSceneXml(text)) projects = [{ name: 'project.xml', title, xml: text }];
        }
        if (!projects.length) {
            return res.status(422).json({ ok: false, error: 'paket terbaca tapi tidak ada <scene> XML di dalamnya', title, diag });
        }
        diag.push(`OK: ${projects.length} project, ${media.length} gambar, ${audio.length} audio`);
        return res.status(200).json({
            ok: true, title,
            projects: projects.map((p) => ({ name: p.name, title: p.title })),
            xml: projects[0].xml,
            xmlByName: Object.fromEntries(projects.map((p) => [p.name, p.xml])),
            media, audio, diag
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message, diag });
    }
};
