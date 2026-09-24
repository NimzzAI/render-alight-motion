/**
 * Ekspor frame-by-frame ke file WebM.
 *
 * Cara kerjanya: tiap frame scene dirender ke canvas, dibungkus jadi VideoFrame,
 * di-encode pakai WebCodecs (VideoEncoder) lalu dimux ke container WebM oleh
 * muxer kecil di file ini (tanpa library luar, biar bisa jalan offline).
 *
 * Kalau browser-nya nggak punya WebCodecs, otomatis turun ke mode kompatibilitas
 * pakai MediaRecorder + captureStream(0) (real-time, kualitas lebih kasar, dan
 * track audio belum ikut).
 *
 * Track audio: sumber audio project didecode, dipotong di grid waktu project
 * (playbackRate + offset yang sama dengan preview), lalu di-encode ke Opus oleh
 * AudioEncoder dan dimux sebagai track 2. Jadi file .webm hasilnya sudah berisi
 * gambar + suara, bukan canvas yang diputar barengan elemen audio.
 */

// ----------------------------------------------------------------- EBML/WebM

const ID = {
    EBML: [0x1a, 0x45, 0xdf, 0xa3],
    EBMLVersion: [0x42, 0x86],
    EBMLReadVersion: [0x42, 0xf7],
    EBMLMaxIDLength: [0x42, 0xf2],
    EBMLMaxSizeLength: [0x42, 0xf3],
    DocType: [0x42, 0x82],
    DocTypeVersion: [0x42, 0x87],
    DocTypeReadVersion: [0x42, 0x85],
    Segment: [0x18, 0x53, 0x80, 0x67],
    Info: [0x15, 0x49, 0xa9, 0x66],
    TimestampScale: [0x2a, 0xd7, 0xb1],
    MuxingApp: [0x4d, 0x80],
    WritingApp: [0x57, 0x41],
    Duration: [0x44, 0x89],
    Tracks: [0x16, 0x54, 0xae, 0x6b],
    TrackEntry: [0xae],
    TrackNumber: [0xd7],
    TrackUID: [0x73, 0xc5],
    TrackType: [0x83],
    CodecID: [0x86],
    Video: [0xe0],
    PixelWidth: [0xb0],
    PixelHeight: [0xba],
    Audio: [0xe1],
    SamplingFrequency: [0xb5],
    Channels: [0x9f],
    CodecPrivate: [0x63, 0xa2],
    CodecDelay: [0x56, 0xaa],
    SeekPreRoll: [0x56, 0xbb],
    Cues: [0x1c, 0x53, 0xbb, 0x6b],
    CuePoint: [0xbb],
    CueTime: [0xb3],
    CueTrackPositions: [0xb7],
    CueTrack: [0xf7],
    CueClusterPosition: [0xf1],
    Cluster: [0x1f, 0x43, 0xb6, 0x75],
    Timestamp: [0xe7],
    SimpleBlock: [0xa3]
};

/** Ukuran EBML (vint): nilai + penanda panjang di byte paling depan. */
function vintSize(value) {
    const out = [];
    let n = 1;
    while (n < 8 && value >= Math.pow(2, 7 * n) - 1) n++;
    for (let i = n - 1; i >= 0; i--) out.push((value >>> (8 * i)) & 0xff);
    out[0] |= 1 << (8 - n);
    return out;
}

function bytes(...parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
}

function elem(id, payload) {
    return bytes(new Uint8Array(id), new Uint8Array(vintSize(payload.length)), payload);
}

/** uint EBML; kalau `fixed` diisi, lebarnya dipatok (biar ukuran elemen stabil). */
function uintPayload(value, fixed) {
    let n = fixed || 1;
    if (!fixed) while (n < 8 && value >= Math.pow(2, 8 * n)) n++;
    const out = new Uint8Array(n);
    let v = value;
    for (let i = n - 1; i >= 0; i--) { out[i] = v & 0xff; v = Math.floor(v / 256); }
    return out;
}

function uint(id, value, fixed) { return elem(id, uintPayload(value, fixed)); }
function float64(id, value) {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setFloat64(0, value, false);
    return elem(id, out);
}
function str(id, value) { return elem(id, new TextEncoder().encode(value)); }
function bin(id, data) { return elem(id, data); }

/**
 * Menyusun file WebM dari daftar frame yang sudah di-encode.
 * Semua frame ditahan di memori dulu supaya ukuran elemen (Segment, Cues)
 * bisa dihitung pasti dan file-nya bisa di-seek.
 */
export class WebMWriter {
    constructor({ width, height, codecId = 'V_VP9', fps = 30, writingApp = 'am-runtime-export' }) {
        this.width = width;
        this.height = height;
        this.codecId = codecId;
        this.fps = fps;
        this.writingApp = writingApp;
        this.frames = [];
        this.audio = [];
        this.audioInfo = null;
        this.clusterMs = 2000;
    }

    /** @param {Uint8Array} data frame ter-encode, @param {number} timestampUs */
    addFrame(data, timestampUs, keyFrame) {
        this.frames.push({ data, tsMs: Math.round(timestampUs / 1000), keyFrame: !!keyFrame });
    }

    /** Daftarkan track audio (Opus). Dipanggil sebelum packet pertama. */
    setAudioTrack({ codecId = 'A_OPUS', sampleRate, channels, codecPrivate, codecDelayNs = 6500000, seekPreRollNs = 80000000, packetMs = 20 }) {
        this.audioInfo = { codecId, sampleRate, channels: channels || 2, codecPrivate, codecDelayNs, seekPreRollNs, packetMs };
    }

    /** @param {Uint8Array} data paket audio ter-encode, @param {number} timestampUs */
    addAudioPacket(data, timestampUs, durationUs) {
        this.audio.push({
            data,
            tsMs: Math.round(timestampUs / 1000),
            durMs: durationUs ? Math.round(durationUs / 1000) : 20
        });
    }

    get frameCount() { return this.frames.length; }
    get audioCount() { return this.audio.length; }
    get hasAudio() { return !!(this.audioInfo && this.audio.length); }
    get byteLength() { let n = 0; for (const f of this.frames) n += f.data.length; return n; }
    get audioByteLength() { let n = 0; for (const a of this.audio) n += a.data.length; return n; }

    /** header SimpleBlock: [track vint][int16 timestamp relatif][flags] */
    _block(item, clusterTs) {
        const rel = Math.max(0, item.tsMs - clusterTs);
        const head = new Uint8Array(4);
        head[0] = 0x80 | item.track;            // track 1 = video, 2 = audio
        new DataView(head.buffer).setInt16(1, rel, false);
        head[3] = item.video
    ? (item.keyFrame ? 0x80 : 0x00)
    : 0x00;
        return bin(ID.SimpleBlock, bytes(head, item.data));
    }

    /**
     * Cluster dimulai di keyframe video, lalu paket audio ditempelkan ke cluster
     * terakhir yang sudah dimulai. Jadi CuePoint tetap menunjuk keyframe video
     * dan tidak ada blok yang timestamp-nya mendahului cluster-nya.
     */
    _buildClusters() {
        const videoItems = this.frames.map((f, i) => ({ tsMs: f.tsMs, keyFrame: f.keyFrame, data: f.data, track: 1, video: true, order: i }));
        const audioItems = this.audio.map((a, i) => ({ tsMs: a.tsMs, keyFrame: true, data: a.data, track: 2, video: false, order: i }));
        const starts = [];
        for (const f of videoItems) {
            if (!f.keyFrame) continue;
        
            if (
                !starts.length ||
                f.tsMs - starts[starts.length - 1] >= this.clusterMs
            ) {
                starts.push(f.tsMs);
            }
        }
        
        if (!starts.length || starts[0] !== videoItems[0]?.tsMs) {
            starts.unshift(videoItems[0]?.tsMs || 0);
        }
        const bucketOf = (ts) => {
            let lo = 0;
            let hi = starts.length - 1;
            while (lo < hi) {
                const mid = (lo + hi + 1) >> 1;
                if (starts[mid] <= ts) lo = mid; else hi = mid - 1;
            }
            return lo;
        };
        const buckets = starts.map((tsMs) => ({ tsMs, items: [] }));
        for (const item of videoItems.concat(audioItems)) buckets[bucketOf(item.tsMs)].items.push(item);
        for (const b of buckets) {
            b.items.sort((x, y) => (x.tsMs - y.tsMs) || (x.video === y.video ? x.order - y.order : (x.video ? -1 : 1)));
        }
        this._clusterList = buckets;
        return buckets.map((b) => elem(ID.Cluster, bytes(uint(ID.Timestamp, b.tsMs), ...b.items.map((it) => this._block(it, b.tsMs)))));
    }

    /** @returns {Uint8Array} isi file webm siap di-download */
    finish() {
        const clusterBufs = this._buildClusters();
        const lastTs = this.frames.length ? this.frames[this.frames.length - 1].tsMs : 0;
        const videoMs = this.frames.length ? lastTs + 1000 / this.fps : 0;
        const lastAudio = this.audio.length ? this.audio[this.audio.length - 1] : null;
        const audioMs = lastAudio ? lastAudio.tsMs + (lastAudio.durMs || this.audioInfo.packetMs) : 0;
        const durationMs = Math.max(videoMs, audioMs);

        const info = elem(ID.Info, bytes(
            uint(ID.TimestampScale, 1000000),
            str(ID.MuxingApp, this.writingApp),
            str(ID.WritingApp, this.writingApp),
            float64(ID.Duration, durationMs)
        ));

        const videoTrack = elem(ID.TrackEntry, bytes(
            uint(ID.TrackNumber, 1),
            uint(ID.TrackUID, 1),
            uint(ID.TrackType, 1),
            str(ID.CodecID, this.codecId),
            elem(ID.Video, bytes(uint(ID.PixelWidth, this.width), uint(ID.PixelHeight, this.height)))
        ));
        const audioTrack = this.hasAudio ? elem(ID.TrackEntry, bytes(
            uint(ID.TrackNumber, 2),
            uint(ID.TrackUID, 2),
            uint(ID.TrackType, 2),
            str(ID.CodecID, this.audioInfo.codecId),
            bin(ID.CodecPrivate, this.audioInfo.codecPrivate),
            uint(ID.CodecDelay, this.audioInfo.codecDelayNs),
            uint(ID.SeekPreRoll, this.audioInfo.seekPreRollNs),
            elem(ID.Audio, bytes(
                float64(ID.SamplingFrequency, this.audioInfo.sampleRate),
                uint(ID.Channels, this.audioInfo.channels)
            ))
        )) : new Uint8Array(0);
        const tracks = elem(ID.Tracks, bytes(videoTrack, audioTrack));

        // CueClusterPosition ditulis 8 byte (lebar tetap) supaya ukuran Cues
        // bisa dihitung sekali jalan tanpa perhitungan berputar.
        const clusterTs = (this._clusterList || []).map((c) => c.tsMs);
        const cueTrackPos = (offset) => elem(ID.CueTrackPositions, bytes(
            uint(ID.CueTrack, 1),
            uint(ID.CueClusterPosition, offset, 8)
        ));
        const cuesEmpty = elem(ID.Cues, bytes(...clusterTs.map((ts) => elem(ID.CuePoint, bytes(
            uint(ID.CueTime, ts),
            cueTrackPos(0)
        )))));
        let at = info.length + tracks.length + cuesEmpty.length;
        const cues = elem(ID.Cues, bytes(...clusterTs.map((ts, i) => {
            void i;
            const point = elem(ID.CuePoint, bytes(uint(ID.CueTime, ts), cueTrackPos(at)));
            at += clusterBufs[i].length;
            return point;
        })));

        if (cues.length !== cuesEmpty.length) {
            throw new Error('ukuran Cues berubah saat offset dihitung');
        }
        const segmentBody = bytes(info, tracks, cues, ...clusterBufs);
        const header = elem(ID.EBML, bytes(
            uint(ID.EBMLVersion, 1),
            uint(ID.EBMLReadVersion, 1),
            uint(ID.EBMLMaxIDLength, 4),
            uint(ID.EBMLMaxSizeLength, 8),
            str(ID.DocType, 'webm'),
            uint(ID.DocTypeVersion, 2),
            uint(ID.DocTypeReadVersion, 2)
        ));
        return bytes(header, elem(ID.Segment, segmentBody));
    }

}

// ------------------------------------------------------------ encode + render

const CODECS = [
    { id: 'vp8', codecId: 'V_VP8', codec: 'vp8' },
    { id: 'vp9', codecId: 'V_VP9', codec: 'vp09.00.10.08' },
    { id: 'av1', codecId: 'V_AV1', codec: 'av01.0.04M.08' }
];

export function exportSupport() {
    return {
        webcodecs: typeof globalThis.VideoEncoder === 'function' && typeof globalThis.VideoFrame === 'function',
        mediaRecorder: typeof globalThis.MediaRecorder === 'function',
        audioEncoder: typeof globalThis.AudioEncoder === 'function' && typeof globalThis.AudioData === 'function'
            && typeof globalThis.OfflineAudioContext === 'function'
    };
}

/** Cari codec+config yang didukung browser ini. */
export async function pickCodec({ width, height, bitrate, fps }) {
    for (const candidate of CODECS) {
        const config = {
            codec: candidate.codec,
            width,
            height,
            bitrate,
            framerate: fps,
            latencyMode: 'quality'
        };
        
        try {
            const res = await VideoEncoder.isConfigSupported(config);
            if (res && res.supported) return { ...candidate, config };
        } catch { /* coba kandidat berikutnya */ }
    }
    return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OPUS_RATE = 48000;     // Opus di WebM selalu 48 kHz
const OPUS_PRE_SKIP = 312;   // lookahead encoder Opus (6.5 ms @48k), sama seperti MediaRecorder Chrome

/** OpusHead 19 byte; wajib ditulis sebagai CodecPrivate di track A_OPUS. */
function opusHead(channels, preSkip, inputSampleRate) {
    const head = new Uint8Array(19);
    head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
    head[8] = 1;                       // versi
    head[9] = channels;
    head[10] = preSkip & 0xff;
    head[11] = (preSkip >> 8) & 0xff;
    head[12] = inputSampleRate & 0xff;
    head[13] = (inputSampleRate >> 8) & 0xff;
    head[14] = (inputSampleRate >> 16) & 0xff;
    head[15] = (inputSampleRate >> 24) & 0xff;
    head[16] = 0;                      // output gain
    head[17] = 0;
    head[18] = 0;                      // mapping family
    return head;
}

/**
 * Siapkan track audio untuk diekspor: decode file sumber, render potongan yang
 * pas dengan rentang waktu project (memakai rate + offset yang sama seperti
 * preview), lalu encode ke Opus.
 *
 * @param {object} opts
 * @param {string} opts.url          sumber audio (mp3/mp4/aac)
 * @param {number} opts.startMs      waktu project awal (biasanya 0)
 * @param {number} opts.endMs        waktu project akhir
 * @param {number} [opts.rate]       playbackRate audio, seperti di preview
 * @param {number} [opts.offsetMs]   geser gambar vs audio (+ = gambar lebih dulu)
 */
export async function prepareAudioTrack({
    url, startMs = 0, endMs, rate = 1, offsetMs = 0,
    sampleRate = OPUS_RATE, bitrate = 128000, onProgress = () => {}
}) {
    if (typeof globalThis.AudioEncoder !== 'function' || typeof globalThis.AudioData !== 'function') {
        throw new Error('WebCodecs audio (AudioEncoder) tidak ada di browser ini');
    }
    if (typeof globalThis.OfflineAudioContext !== 'function') {
        throw new Error('OfflineAudioContext tidak ada di browser ini');
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error('gagal memuat audio: HTTP ' + res.status);
    const raw = await res.arrayBuffer();
    onProgress({ phase: 'audio', stage: 'decode', bytes: raw.byteLength });

    const decodeCtx = new OfflineAudioContext(2, 1, sampleRate);
    const decoded = await decodeCtx.decodeAudioData(raw);
    const channels = Math.max(1, Math.min(2, decoded.numberOfChannels || 1));
    const seconds = Math.max(0, (endMs - startMs) / 1000);
    const length = Math.max(1, Math.round(seconds * sampleRate));

    const ctx = new OfflineAudioContext(channels, length, sampleRate);
    const node = ctx.createBufferSource();
    const speed = Math.max(0.0625, Math.min(4, Number(rate) || 1));
    node.buffer = decoded;
    node.playbackRate.value = speed;
    node.connect(ctx.destination);
    const shiftSec = (Number(offsetMs) || 0) / 1000;
    // media(t) = (t - shift) * speed; start() cuma boleh offset >= 0, jadi kalau
    // gambar lebih dulu (shift > 0) sumbernya baru dibunyikan setelah shift.
    if (shiftSec >= 0) node.start(shiftSec, 0);
    else node.start(0, Math.min(Math.max(0, decoded.duration - 0.001), -shiftSec * speed));
    onProgress({ phase: 'audio', stage: 'render', frames: length, decoded: decoded.duration });
    const rendered = await ctx.startRendering();

    const config = { codec: 'opus', sampleRate, numberOfChannels: channels, bitrate: Math.round(bitrate) };
    let supported = null;
    try { supported = await AudioEncoder.isConfigSupported(config); } catch { supported = null; }
    if (!supported || !supported.supported) {
        throw new Error('AudioEncoder menolak Opus ' + sampleRate + ' Hz / ' + channels + ' ch');
    }

    const packets = [];
    let encodeError = null;
    const encoder = new AudioEncoder({
        output: (chunk) => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            packets.push({ data, tsUs: chunk.timestamp, durUs: chunk.duration || 20000 });
        },
        error: (e) => { encodeError = e; }
    });
    encoder.configure(supported.config || config);

    const blockFrames = Math.max(120, Math.round(sampleRate / 50));   // 20 ms
    const planes = [];
    for (let c = 0; c < channels; c++) planes.push(rendered.getChannelData(c));
    try {
        for (let i = 0; i < rendered.length; i += blockFrames) {
            if (encodeError) throw encodeError;
            const n = Math.min(blockFrames, rendered.length - i);
            const data = new Float32Array(n * channels);
            for (let c = 0; c < channels; c++) data.set(planes[c].subarray(i, i + n), c * n);
            const audioData = new AudioData({
                format: 'f32-planar',
                sampleRate,
                numberOfFrames: n,
                numberOfChannels: channels,
                timestamp: Math.round((i / sampleRate) * 1e6),
                data
            });
            encoder.encode(audioData);
            audioData.close();
            while (encoder.encodeQueueSize > 8) { await sleep(2); if (encodeError) throw encodeError; }
            if ((i / blockFrames) % 25 === 0) {
                onProgress({ phase: 'audio', stage: 'encode', frames: i + n, total: rendered.length, packets: packets.length });
            }
        }
        await encoder.flush();
    } finally {
        try { encoder.close(); } catch { /* sudah tertutup */ }
    }
    if (encodeError) throw encodeError;
    if (!packets.length) throw new Error('encoder Opus tidak menghasilkan paket audio');
    return {
        packets, sampleRate, channels, seconds,
        codecPrivate: opusHead(channels, OPUS_PRE_SKIP, sampleRate),
        preSkip: OPUS_PRE_SKIP
    };
}

/**
 * Ambil isi canvas render dengan aman.
 *
 * Canvas WebGL dibuat dengan preserveDrawingBuffer=false, jadi isinya tidak
 * dijamin masih utuh saat dibaca/di-encode. Solusinya render dulu, salin ke
 * canvas 2D (drawImage = sinkron), baru bikin VideoFrame dari salinan itu.
 */
function createSnapshotTarget(width, height, source) {
    if (typeof document === 'undefined' || !document.createElement) return { canvas: source, ctx: null };
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const ctx = c.getContext('2d');
    if (!ctx || typeof ctx.drawImage !== 'function') return { canvas: source, ctx: null };
    return { canvas: c, ctx };
}

function grabFrame(target, source, width, height) {
    if (target.ctx) target.ctx.drawImage(source, 0, 0, width, height);
    return target.canvas;
}

/**
 * Render + encode semua frame dari `startMs` sampai `endMs`.
 *
 * @param {object} opts
 * @param {HTMLCanvasElement} opts.canvas      canvas tempat scene dirender
 * @param {(timeMs:number)=>void} opts.renderFrame
 * @param {(ev:object)=>void} [opts.onProgress]
 * @param {()=>boolean} [opts.isCancelled]
 */
export async function exportFrames({
    canvas,
    renderFrame,
    startMs = 0,
    endMs,
    fps = 30,
    bitrate = 6000000,
    onProgress = () => {},
    isCancelled = () => false,
    keyFrameEverySec = 2,
    audio = null
}) {
    const width = canvas.width;
    const height = canvas.height;
    const intervalMs = 1000 / fps;
    const totalFrames = Math.max(1, Math.round((endMs - startMs) / intervalMs) + 1);
    const support = exportSupport();
    const snapshot = createSnapshotTarget(width, height, canvas);

    const started = performance.now();
    const report = (extra) => onProgress({
        total: totalFrames,
        elapsedMs: performance.now() - started,
        ...extra
    });

    if (!support.webcodecs) {
        const fallback = await exportFramesMediaRecorder({ canvas, snapshot, renderFrame, startMs, intervalMs, totalFrames, fps, report, isCancelled });
        if (audio && audio.url && !fallback.audio) {
            fallback.audioError = 'mode MediaRecorder (real-time) belum menyertakan track audio';
        }
        return fallback;
    }

    const picked = await pickCodec({ width, height, bitrate, fps });
    if (!picked) throw new Error('Tidak ada codec video (VP9/VP8) yang didukung browser ini.');
    onProgress({ phase: 'mulai', total: totalFrames, codec: picked.id, width, height, bitrate, fps });

    const writer = new WebMWriter({ width, height, codecId: picked.codecId, fps });
    let audioInfo = null;
    let audioError = null;
    if (audio && audio.url) {
        try {
            const track = await prepareAudioTrack({
                url: audio.url,
                startMs,
                endMs,
                rate: audio.rate,
                offsetMs: audio.offsetMs,
                bitrate: audio.bitrate || 128000,
                onProgress: (ev) => report(ev)
            });
            writer.setAudioTrack({
                sampleRate: track.sampleRate,
                channels: track.channels,
                codecPrivate: track.codecPrivate,
                codecDelayNs: track.preSkip * 1e9 / track.sampleRate,
                packetMs: Math.round((track.packets[0].durUs || 20000) / 1000)
            });
            for (const packet of track.packets) writer.addAudioPacket(packet.data, packet.tsUs, packet.durUs);
            audioInfo = {
                packets: track.packets.length,
                sampleRate: track.sampleRate,
                channels: track.channels,
                seconds: track.seconds,
                bytes: writer.audioByteLength
            };
            report({ phase: 'audio', stage: 'ok', ...audioInfo });
        } catch (e) {
            audioError = e.message;
            report({ phase: 'audio', stage: 'gagal', message: e.message });
        }
    }
    let encodeError = null;
    const encoder = new VideoEncoder({
        output: (chunk) => {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            writer.addFrame(data, chunk.timestamp, chunk.type === 'key');
        },
        error: (e) => { encodeError = e; }
    });
    encoder.configure(picked.config);

    const keyEvery = Math.max(1, Math.round(fps * keyFrameEverySec));
    const times = [];
    let minMs = Infinity;
    let maxMs = 0;

    try {
        for (let i = 0; i < totalFrames; i++) {
            if (isCancelled()) break;
            if (encodeError) throw encodeError;
            const frameStart = performance.now();
            const timeMs = startMs + i * intervalMs;
            renderFrame(timeMs);
            const frame = new VideoFrame(grabFrame(snapshot, canvas, width, height), {
                timestamp: Math.round(timeMs * 1000),
                duration: Math.round(intervalMs * 1000)
            });
            encoder.encode(frame, { keyFrame: i % keyEvery === 0 });
            frame.close();
            // beri napas ke encoder + UI biar animasi loading tetap jalan
            while (encoder.encodeQueueSize > 6) {
                await sleep(4);
                if (encodeError) throw encodeError;
            }
            const cost = performance.now() - frameStart;
            times.push(cost);
            if (times.length > 60) times.shift();
            minMs = Math.min(minMs, cost);
            maxMs = Math.max(maxMs, cost);
            const avg = times.reduce((a, b) => a + b, 0) / times.length;
            report({
                phase: 'render',
                frame: i + 1,
                msPerFrame: cost,
                avgMs: avg,
                minMs,
                maxMs,
                renderFps: 1000 / avg,
                etaMs: avg * (totalFrames - i - 1),
                encodedBytes: writer.byteLength
            });
            await sleep(0);
        }
        if (!isCancelled()) {
            report({ phase: 'flush', frame: writer.frameCount, encodedBytes: writer.byteLength });
            await encoder.flush();
        }
    } finally {
        try { encoder.close(); } catch { /* sudah tertutup */ }
    }

    const file = writer.finish();
    const res = {
        blob: new Blob(
    [file],
    { type: 'video/webm;codecs=vp9,opus' }
),
        codec: picked.id,
        width,
        height,
        fps,
        frames: writer.frameCount,
        mode: 'webcodecs',
        audio: audioInfo,
        audioError,
        cancelled: isCancelled()
    };
    report({ phase: 'selesai', ...res, bytes: res.blob.size });
    return res;
}

/** Fallback: MediaRecorder + captureStream(0), jalan real-time. */
async function exportFramesMediaRecorder({ canvas, snapshot, renderFrame, startMs, intervalMs, totalFrames, fps, report, isCancelled }) {
    // Rekam dari canvas salinan supaya isi buffer GL yang bisa kedaluwarsa tidak
    // bikin frame hitam/tertahan.
    const streamSource = snapshot && snapshot.canvas && typeof snapshot.canvas.captureStream === 'function'
        ? snapshot.canvas
        : canvas;
    if (typeof streamSource.captureStream !== 'function') {
        throw new Error('Browser ini tidak mendukung WebCodecs maupun captureStream.');
    }
    const stream = streamSource.captureStream(0);
    const track = stream.getVideoTracks()[0];
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
        .find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';
    const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6000000 });
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((r) => { recorder.onstop = r; });
    recorder.start();

    const started = performance.now();
    const times = [];
    for (let i = 0; i < totalFrames; i++) {
        if (isCancelled()) break;
        const frameStart = performance.now();
        renderFrame(startMs + i * intervalMs);
        grabFrame(snapshot, canvas, canvas.width, canvas.height);
        track.requestFrame();
        const cost = performance.now() - frameStart;
        times.push(cost);
        if (times.length > 60) times.shift();
        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        report({
            phase: 'render',
            frame: i + 1,
            msPerFrame: cost,
            avgMs: avg,
            minMs: Math.min(...times),
            maxMs: Math.max(...times),
            renderFps: 1000 / avg,
            etaMs: 0,
            encodedBytes: 0,
            realtime: true
        });
        // mode ini memang real-time: tahan kecepatan sesuai fps target
        const wait = intervalMs - (performance.now() - frameStart);
        await sleep(Math.max(0, wait));
    }
    recorder.stop();
    await stopped;
    const blob = new Blob(chunks, { type: 'video/webm' });
    const res = {
        blob, codec: mime, width: canvas.width, height: canvas.height,
        fps, frames: totalFrames, mode: 'mediarecorder', realtime: true, cancelled: isCancelled(),
        elapsedMs: performance.now() - started
    };
    report({ phase: 'selesai', ...res, bytes: blob.size });
    return res;
}
