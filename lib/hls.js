// HLS 下载器：清单 -> key/分段(AES-128-CBC) -> 合并TS -> ffmpeg 封装 mp4
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const FFMPEG = 'C:/ffmpeg/bin/ffmpeg.exe';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

function absolute(base, rel) { try { return new URL(rel, base).href; } catch (e) { return rel; } }

async function fetchBuf(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) { lastErr = e; await sleep(700 * (i + 1)); }
  }
  throw lastErr;
}

function parseM3U8(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  let curKey = null, mediaSeq = 0;
  const segs = [];
  for (const line of lines) {
    const l = line.trim();
    if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSeq = parseInt(l.split(':')[1]) || 0;
    else if (l.startsWith('#EXT-X-KEY:')) {
      const method = (l.match(/METHOD=([^,]+)/) || [])[1];
      if (method === 'NONE') { curKey = null; continue; }
      const uri = (l.match(/URI="([^"]+)"/) || [])[1];
      const iv = (l.match(/IV=0[xX]([0-9a-fA-F]+)/) || [])[1];
      curKey = { method, uri: absolute(baseUrl, uri), iv: iv ? Buffer.from(iv, 'hex') : null };
    } else if (l && !l.startsWith('#')) {
      segs.push({ url: absolute(baseUrl, l), key: curKey, seq: mediaSeq + segs.length });
    }
  }
  return segs;
}

function decryptSeg(buf, key, seq) {
  if (!key || !key.keyBuf) return buf;
  const ivBuf = key.iv || (() => { const b = Buffer.alloc(16); b.writeBigUInt64BE(BigInt(seq), 8); return b; })();
  const d = crypto.createDecipheriv('aes-128-cbc', key.keyBuf, ivBuf);
  return Buffer.concat([d.update(buf), d.final()]);
}

// 从分段URL推导清单URL
function deriveManifest(segUrl) {
  const q = segUrl.slice(segUrl.indexOf('?'));
  if (/\/drm\/main_\d+\.ts\?/.test(segUrl)) return segUrl.replace(/\/drm\/main_\d+\.ts\?/, '/drm/main.m3u8?');
  if (/\/asset\/[^/]+\/[^/]+_\d+\.ts\?/.test(segUrl)) return segUrl.replace(/_(\d+)\.ts\?/, '.m3u8?');
  if (/-sd-encrypt-stream-\d+\.ts\?/.test(segUrl)) return segUrl.replace(/-sd-encrypt-stream-\d+\.ts\?/, '-sd-encrypt-stream.m3u8?');
  return segUrl.replace(/_\d+\.ts\?/, '.m3u8?');
}

async function validateManifest(manifest) {
  try {
    const r = await fetch(manifest, { headers: { 'User-Agent': UA } });
    const t = await r.text();
    return { status: r.status, segs: (t.match(/\.ts/g) || []).length, aes: /METHOD=AES-128/.test(t) };
  } catch (e) { return { status: 0, err: e.message.slice(0, 80) }; }
}

async function download(manifest, outFile, onProgress) {
  const mtext = await fetchBuf(manifest).then(b => b.toString('utf8'));
  const segs = parseM3U8(mtext, manifest);
  if (!segs.length) throw new Error('清单无分段');
  const keyUrls = [...new Set(segs.filter(s => s.key).map(s => s.key.uri))];
  for (const ku of keyUrls) {
    const kb = await fetchBuf(ku);
    for (const s of segs) if (s.key && s.key.uri === ku) s.key.keyBuf = kb;
  }
  const tmpTs = outFile + '.tmp.ts';
  const ws = fs.createWriteStream(tmpTs);
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    let buf, ok = false, lastErr;
    for (let t = 0; t < 4 && !ok; t++) {
      try { buf = await fetchBuf(s.url, 2); ok = true; } catch (e) { lastErr = e; await sleep(1200); }
    }
    if (!ok) { ws.end(); try { fs.unlinkSync(tmpTs); } catch (_) {} throw new Error('分段下载失败: ' + lastErr.message); }
    buf = decryptSeg(buf, s.key, s.seq);
    await new Promise(res => ws.write(buf, res));
    if (onProgress && (i % 10 === 0 || i === segs.length - 1)) onProgress(Math.round((i + 1) * 100 / segs.length), segs.length);
  }
  await new Promise(res => ws.end(res));
  const mp4 = await new Promise(resolve => {
    execFile(FFMPEG, ['-y', '-loglevel', 'error', '-i', tmpTs, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', outFile], { maxBuffer: 1024 * 1024 }, (err, so, se) => resolve({ err: err ? (se || err.message).slice(-300) : null }));
  });
  if (mp4.err) { try { fs.unlinkSync(tmpTs); } catch (_) {} throw new Error('封装失败: ' + mp4.err); }
  const size = fs.statSync(outFile).size;
  fs.unlinkSync(tmpTs);
  return { size, segs: segs.length };
}

module.exports = { deriveManifest, validateManifest, download, sleep };
