// 小鹅通已购课程下载工具 - 本地服务
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { chromium } = require('playwright-core');
const hls = require('./lib/hls');

const PORT = 5273;
const ROOT = __dirname;
const PROFILE = path.join(ROOT, 'profile');           // 后台工作上下文
const PROFILE_LOGIN = path.join(ROOT, 'profile-login'); // 登录窗口（独立目录，避免与后台实例抢锁）
const OUTDIR = path.join(ROOT, 'downloads');
const STATE_FILE = path.join(ROOT, 'state.json');
const COOKIES_FILE = path.join(ROOT, 'cookies.json');
const SETTINGS_FILE = path.join(ROOT, 'settings.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 浏览器路径：优先环境变量，其次 Chrome，再 Edge
function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean);
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch (_) {} }
  return candidates[1];
}
const CHROME = findBrowser();

const DEFAULT_SETTINGS = { videos: 2, segments: 4 };
function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; }
  catch (_) { return { ...DEFAULT_SETTINGS }; }
}

const STUDY_LOGIN = 'https://study.xiaoe-tech.com/t_l/learnLogin';
const STUDY_INDEX = 'https://study.xiaoe-tech.com/t_l/learnIndex#/muti_index';

const state = {
  loggedIn: fs.existsSync(STATE_FILE) && JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).loggedIn || false,
  windowOpen: false,
  loginMessage: '未登录',
  courses: null,
  videos: {},      // rid -> video list
  queue: [],
  jobs: {},        // rid -> {title, course, status, pct, message, file}
  running: false,
  settings: loadSettings(),
};

// ============ Playwright 会话 ============
let loginCtx = null;   // 有头登录窗口
let workerCtx = null;  // 无头工作上下文
let studyPage = null;  // 学习中心页（复用）

async function openLoginWindow() {
  if (loginCtx) return;
  try {
    loginCtx = await chromium.launchPersistentContext(PROFILE_LOGIN, {
      executablePath: CHROME,
      headless: false,
      viewport: { width: 1280, height: 860 },
      args: ['--window-size=1280,860', '--mute-audio', '--disable-blink-features=AutomationControlled'],
    });
  } catch (e) {
    loginCtx = null; state.windowOpen = false;
    const msg = /ProcessSingleton|already (in use|running)|user data directory/i.test(e.message || '')
      ? '浏览器配置目录被占用，请先关闭残留的 Chrome 窗口后重试'
      : '浏览器启动失败：' + (e.message || '').split('\n')[0] + '（当前浏览器：' + CHROME + '）';
    state.loginMessage = msg;
    throw new Error(msg);
  }
  state.windowOpen = true;
  const page = loginCtx.pages()[0] || await loginCtx.newPage();
  await page.goto(STUDY_LOGIN, { waitUntil: 'domcontentloaded' }).catch(() => {});
  pollLogin(page);
}

async function pollLogin(page) {
  for (let i = 0; i < 3600; i++) {
    if (!loginCtx) return; // 窗口被关闭
    try {
      const url = page.url();
      if (url.includes('learnIndex') || (!url.includes('learnLogin') && url.includes('/t_l/'))) {
        const ok = await page.evaluate(`fetch('/xe.learn-pc.user/check_token', {method:'POST', credentials:'include'}).then(r=>r.json()).then(j=>j.code===0).catch(()=>false)`);
        if (ok) {
          state.loggedIn = true;
          state.loginMessage = '登录成功';
          fs.writeFileSync(STATE_FILE, JSON.stringify({ loggedIn: true }));
          // 全量导出 cookie（含 HttpOnly），供 worker 注入
          try {
            const all = await loginCtx.cookies();
            fs.writeFileSync(COOKIES_FILE, JSON.stringify(all.filter(c => /xiaoe|xet\.pomoho|xiaoecloud|knowlink/i.test(c.domain)), null, 2));
          } catch (_) {}
          try { await loginCtx.close(); } catch (_) {}
          loginCtx = null; state.windowOpen = false;
          console.log('[login] 登录成功，cookie 已保存');
          return;
        }
      }
    } catch (e) {
      // 窗口被用户手动关闭
      if (/closed|destroyed|Target/i.test(e.message || '')) {
        try { await loginCtx.close(); } catch (_) {}
        loginCtx = null; state.windowOpen = false;
        state.loginMessage = '登录窗口已关闭（未检测到登录成功）';
        return;
      }
    }
    await sleep(2000);
  }
}

let workerInit = null;
async function ensureWorker() {
  if (!state.loggedIn) throw new Error('未登录');
  if (!workerCtx) {
    if (!workerInit) {
      workerInit = (async () => {
        workerCtx = await chromium.launchPersistentContext(PROFILE, {
          executablePath: CHROME,
          headless: true,
          args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required', '--disable-gpu', '--no-sandbox'],
        });
        // 注入保存的 cookie（登录态跨重启）
        if (fs.existsSync(COOKIES_FILE)) {
          const saved = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
          if (saved.length) await workerCtx.addCookies(saved).catch(() => {});
        }
        studyPage = null;
      })().finally(() => { workerInit = null; });
    }
    await workerInit;
  }
  if (!studyPage || studyPage.isClosed()) {
    studyPage = await workerCtx.newPage();
    await studyPage.goto(STUDY_INDEX, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await sleep(1500);
  }
  return workerCtx;
}

// 学习中心：拉已购课程列表
async function fetchCourses() {
  const ctx = await ensureWorker();
  const list = await studyPage.evaluate(`(async () => {
    const out = [];
    for (let p = 0; p < 10; p++) {
      const r = await fetch('/xe.learn-pc/my_attend_normal_list.get/1.0.1', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({page_index: p, page_size: 20, data_type: 'all'}),
        credentials: 'include'
      }).then(x => x.json());
      const l = r.data && (r.data.list || r.data.attend_list || (Array.isArray(r.data) ? r.data : null));
      if (r.code !== 0 || !l || !l.length) break;
      out.push(...l);
      if (l.length < 20) break;
    }
    return out.map(x => ({title: x.title, shop: x.shop_name, app_id: x.app_id, rid: x.resource_id,
      type: x.resource_type, user_id: x.user_id, h5: x.h5_url, progress: x.learn_progress || 0}));
  })()`);
  // 按 rid 去重
  const seen = new Map();
  for (const c of list) if (!seen.has(c.rid)) seen.set(c.rid, c);
  state.courses = [...seen.values()];
  return state.courses;
}

// 店铺 SSO + 页面
const shopPages = new Map(); // app_id -> page
// 同一店铺共用一个页面，多线程解析时必须串行，避免并发导航互相打断
const appLocks = new Map();
function withAppLock(appId, fn) {
  const prev = appLocks.get(appId) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  appLocks.set(appId, run.catch(() => {}));
  return run;
}
async function ensureShopPage(course) {
  const ctx = await ensureWorker();
  let page = shopPages.get(course.app_id);
  if (page && !page.isClosed()) return page;
  // 1. 拿 SSO 链接
  const sso = await studyPage.evaluate(`(async () => {
    const body = {type: 1, app_id: ${JSON.stringify(course.app_id)}, user_id: ${JSON.stringify(course.user_id || '')},
      resource_type: ${course.type}, resource_id: ${JSON.stringify(course.rid)}, content_app_id: ''};
    const r = await fetch('/xe.learn-pc/get_new_gateway/1.0.0', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body), credentials: 'include'}).then(x => x.json());
    return r.data && r.data.url;
  })()`);
  if (!sso) throw new Error('SSO 获取失败（登录态可能过期，请重新登录）');
  // 2. 访问 SSO 设置店铺 cookie
  page = await ctx.newPage();
  await page.goto(sso, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  await sleep(2500);
  shopPages.set(course.app_id, page);
  return page;
}

// 店铺页内 fetch（表单 bizData 格式）
async function shopApi(page, api, params) {
  const body = Object.keys(params).map(k => 'bizData[' + k + ']=' + encodeURIComponent(params[k] === undefined ? '' : params[k])).join('&');
  return await page.evaluate(`fetch('${api}', {
    method: 'POST', headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: ${JSON.stringify(body)}, credentials: 'include'
  }).then(r => r.json())`);
}

// ============ 通用目录解析（课程/训练营/其他类型） ============
function pickTitle(o) {
  for (const k of ['title', 'resource_title', 'name', 'chapter_title', 'catalog_title']) {
    const v = o[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (v && typeof v === 'object' && typeof v.title === 'string' && v.title.trim()) return v.title.trim();
  }
  return '';
}

// 递归扫描任意 JSON，收集 resource_id / resource_type
function walkResources(node, parentTitle, out, depth) {
  if (!node || typeof node !== 'object' || depth > 14) return;
  if (Array.isArray(node)) { for (const n of node) walkResources(n, parentTitle, out, depth + 1); return; }
  const own = pickTitle(node) || parentTitle;
  const rid = node.resource_id != null ? node.resource_id
    : node.resourceId != null ? node.resourceId
    : node.rid != null ? node.rid : null;
  const rawRt = node.resource_type != null ? node.resource_type
    : node.resourceType != null ? node.resourceType
    : node.resourceTypeStr != null ? node.resourceTypeStr : null;
  const rt = rawRt != null && !isNaN(Number(rawRt)) ? Number(rawRt) : null;
  if (rid) {
    const key = String(rid);
    const isVideo = rt === 3 || (rt == null && /^v_/i.test(key));
    const isColumn = rt === 6 || rt === 8 || (rt == null && /^p_/i.test(key));
    if (isVideo || isColumn) {
      const rec = out.get(key) || { rid: key, type: isVideo ? 3 : 6, title: own, colTitle: parentTitle };
      if (!rec.title && own) rec.title = own;
      out.set(key, rec);
    }
  }
  for (const k of Object.keys(node)) walkResources(node[k], own, out, depth + 1);
}

const hasVideo = out => [...out.values()].some(x => x.type === 3);

// 打开课程页并监听目录接口（同时记下请求，供分页翻页复用）
async function sniffCatalog(page, url, log) {
  const out = new Map();
  const pending = [];
  const captures = [];
  const jsons = [];
  const onResp = resp => {
    const u = resp.url();
    if (!/\/xe\./i.test(u)) return;
    if (!/(course|column|catalog|chapter|item|detail|content|resource|topic)/i.test(u)) return;
    const req = resp.request();
    const cap = {
      url: u,
      method: req.method(),
      body: req.postData() || '',
      contentType: (req.headers()['content-type'] || '').split(';')[0].trim(),
    };
    pending.push((async () => {
      try {
        const ct = resp.headers()['content-type'] || '';
        if (ct && !/json/i.test(ct)) return;
        const j = await resp.json();
        if (log) log.push({ url: u, body: JSON.stringify(j).slice(0, 1500) });
        jsons.push(j);
        walkResources(j, '', out, 0);
        if (!captures.some(c => c.url === cap.url && c.body === cap.body)) captures.push(cap);
      } catch (_) {}
    })());
  };
  page.on('response', onResp);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    for (let i = 0; i < 25 && !hasVideo(out); i++) await sleep(1000);
    await sleep(2500);
    // 页面上滚动一次，触发懒加载的分页请求
    await page.evaluate(`(async () => { for (let y = 0; y < 6; y++) { window.scrollTo(0, document.body.scrollHeight * (y + 1) / 6); await new Promise(r => setTimeout(r, 800)); } })()`).catch(() => {});
    await sleep(1500);
    await Promise.all(pending).catch(() => {});
  } finally {
    page.off('response', onResp);
  }
  return { out, captures, jsons };
}

// 把请求里的页码换成 p / 页大小换成 100
function setPageParam(str, p) {
  if (!str) return str;
  return str
    .replace(/(page_?[iI]ndex(?:%5B%5D|\[\]|%5D|\])?"?\s*[:=]\s*"?)\d+/g, (m, a) => a + p)
    .replace(/([?&]page=)\d+/g, (m, a) => a + p);
}
function setPageSize(str, n) {
  if (!str) return str;
  return str.replace(/(page_?[sS]ize(?:%5B%5D|\[\]|%5D|\])?"?\s*[:=]\s*"?)\d+/g, (m, a) => a + n);
}

async function fetchInPage(page, cap) {
  const code = `fetch(${JSON.stringify(cap.url)}, {
    method: ${JSON.stringify(cap.method)},
    headers: ${JSON.stringify(cap.contentType ? { 'Content-Type': cap.contentType } : {})},
    ${cap.method === 'GET' ? '' : 'body: ' + JSON.stringify(cap.body) + ','}
    credentials: 'include'
  }).then(r => r.text()).catch(e => '')`;
  const txt = await page.evaluate(code).catch(() => '');
  try { return JSON.parse(txt); } catch (_) { return null; }
}

// 对嗅探到的目录请求做翻页，补全被分页/懒加载漏掉的条目
async function expandPagination(page, captures, out, log) {
  for (const cap of [...captures]) {
    let prev = out.size, stale = 0;
    for (let p = 2; p <= 200; p++) {
      const url = setPageParam(cap.url, p);
      const body = setPageParam(cap.body, p);
      if (url === cap.url && body === cap.body) break; // 请求里没有分页参数
      const j = await fetchInPage(page, { ...cap, url: setPageSize(url, 100), body: setPageSize(body, 100) });
      if (!j) break;
      const list = j.data && (j.data.list || j.data.items || j.data.resource_list);
      if (Array.isArray(list) && !list.length) break; // 空页，到底了
      if (log) log.push({ url: 'page' + p + ':' + url, body: JSON.stringify(j).slice(0, 800) });
      walkResources(j, '', out, 0);
      if (out.size === prev) { if (++stale >= 2) break; } else { stale = 0; prev = out.size; }
    }
  }
}

// 逐页拉取某个专栏/课程的条目
async function pullPaged(page, api, key, id, title, out, log) {
  let prev = out.size, stale = 0;
  for (let p = 1; p <= 200; p++) {
    let r;
    try { r = await shopApi(page, api, { [key]: id, page_index: p, page_size: 50 }); } catch (_) { break; }
    if (!r || r.code !== 0) break;
    if (log && p <= 2) log.push({ url: 'p' + p + ':' + api, body: JSON.stringify(r).slice(0, 800) });
    walkResources(r, title, out, 0);
    const list = (r.data && (r.data.list || r.data.items || r.data.resource_list)) || [];
    if (!list.length) break;
    const total = Number((r.data && (r.data.total || r.data.total_count)) || 0);
    if (total && p * list.length >= total) break;
    // 服务端可能把 page_size 限制得更小，所以不按「返回条数 < 请求条数」判停，
    // 而是按「没有新增条目」判停，避免只抓到第一页
    if (out.size === prev) { if (++stale >= 2) break; } else { stale = 0; prev = out.size; }
  }
}

function mapVideos(out) {
  return [...out.values()].filter(x => x.type === 3).map(x => ({ rid: x.rid, title: x.title || x.rid, type: 3 }));
}

// 页面打不开/接口没触发时的兜底：直接从 HTML 里抠 v_ 资源 id
async function htmlFallback(page, out) {
  const html = await page.content().catch(() => '');
  const re = /"resource_?[iI]d"\s*:\s*"(v_[A-Za-z0-9_-]+)"/g;
  let m;
  while ((m = re.exec(html))) if (!out.has(m[1])) out.set(m[1], { rid: m[1], type: 3, title: '', colTitle: '' });
}

// 已知目录接口依次尝试（参数名不同版本有差异）
const TRY_APIS = [
  ['/xe.course.business_go.column.items.get/2.0.0', 'column_id'],
  ['/xe.course.business_go.course.chapter.get/2.0.0', 'course_id'],
  ['/xe.course.business.course.chapter.get/2.0.0', 'course_id'],
  ['/xe.course.business.course.chapter_list.get/2.0.0', 'course_id'],
  ['/xe.course.business.course.catalog.get/2.0.0', 'course_id'],
  ['/xe.course.business_go.course.items.get/2.0.0', 'course_id'],
  ['/xe.course.business.topic.items.get/2.0.0', 'column_id'],
];

async function tryKnownApis(page, course, out, log) {
  for (const [api, key] of TRY_APIS) {
    try {
      await pullPaged(page, api, key, course.rid, course.title, out, log);
      if (hasVideo(out)) return true;
    } catch (_) {}
  }
  return false;
}

// 从响应里收集章节 id，用于逐章节补全
function collectChapterIds(node, set, depth) {
  if (!node || typeof node !== 'object' || depth > 14) return;
  if (Array.isArray(node)) { for (const n of node) collectChapterIds(n, set, depth + 1); return; }
  for (const k of ['chapter_id', 'chapterId', 'catalog_id', 'catalogId', 'section_id']) {
    const v = node[k];
    if (typeof v === 'string' && v.length >= 6 && set.size < 300) set.add(v);
    if (typeof v === 'number' && set.size < 300) set.add(String(v));
  }
  for (const k of Object.keys(node)) collectChapterIds(node[k], set, depth + 1);
}

// 课程按章节懒加载：把请求里的章节 id 换成其它章节再问一遍
async function expandChapters(page, captures, jsons, out, log) {
  const ids = new Set();
  for (const j of jsons) collectChapterIds(j, ids, 0);
  if (ids.size < 2) return;
  const list = [...ids].slice(0, 80);
  let used = 0;
  for (const cap of captures) {
    const hit = list.find(id => cap.url.includes(id) || (cap.body || '').includes(id));
    if (!hit) continue;
    if (++used > 3) break;
    for (const cid of list) {
      if (cid === hit) continue;
      const url = cap.url.split(hit).join(cid);
      const body = (cap.body || '').split(hit).join(cid);
      const j = await fetchInPage(page, { ...cap, url, body });
      if (j) { walkResources(j, '', out, 0); jsons.push(j); }
    }
  }
}

// 课程（type 25/50 等）：通用解析，返回视频条目
async function genericCatalog(course, log) {
  return withAppLock(course.app_id, async () => {
    const page = await ensureShopPage(course);
    const origin = new URL(page.url()).origin;
    const url = /^https?:\/\//i.test(course.h5 || '') ? course.h5 : origin + '/p/course/' + course.rid;
    const { out, captures, jsons } = await sniffCatalog(page, url, log);
    if (!out.size) await htmlFallback(page, out);
    if (!hasVideo(out)) await tryKnownApis(page, course, out, log);
    // 1) 翻页补全
    await expandPagination(page, captures, out, log);
    // 2) 逐章节补全（章节懒加载的情况）
    await expandChapters(page, captures, jsons, out, log);
    // 3) 嵌套专栏再展开一层
    const cols = [...out.values()].filter(x => x.type === 6).map(x => x.rid).slice(0, 50);
    for (const cid of cols) {
      await pullPaged(page, '/xe.course.business_go.column.items.get/2.0.0', 'column_id', cid,
        (out.get(cid) || {}).title || course.title, out, log);
    }
    if (log) log.push({ url: 'SUMMARY', body: 'videos=' + [...out.values()].filter(x => x.type === 3).length + ' columns=' + cols.length + ' captures=' + captures.length + ' jsons=' + jsons.length });
    return [...out.values()].filter(x => x.type === 3).map(x => ({
      rid: x.rid, title: x.title || x.rid, colTitle: x.colTitle || course.title,
    }));
  });
}

// 拉课程的视频列表
async function fetchCourseVideos(course) {
  if (state.videos[course.rid]) return state.videos[course.rid];
  const page = await ensureShopPage(course);
  const origin = new URL(page.url()).origin;
  const videos = [];
  if (course.type === 8) {
    // 大专栏 -> 子专栏 -> 视频
    const t = await shopApi(page, '/xe.course.business.topic.items.get/2.0.0', { column_id: course.rid, page_index: 1, page_size: 50 });
    if (t.code !== 0) throw new Error('子课程列表失败: ' + t.msg);
    for (const col of (t.data.list || [])) {
      videos.push({ colTitle: col.resource_title, colRid: col.resource_id, count: col.resource_count });
    }
    for (const col of videos) {
      const sub = new Map();
      await pullPaged(page, '/xe.course.business_go.column.items.get/2.0.0', 'column_id', col.colRid, col.colTitle, sub, null);
      col.videos = mapVideos(sub);
    }
  } else if (course.type === 6) {
    const sub = new Map();
    await pullPaged(page, '/xe.course.business_go.column.items.get/2.0.0', 'column_id', course.rid, course.title, sub, null);
    videos.push({ colTitle: course.title, colRid: course.rid, videos: mapVideos(sub) });
  } else if (course.type === 3) {
    videos.push({ colTitle: course.title, colRid: course.rid, videos: [{ rid: course.rid, title: course.title, type: 3 }] });
  } else {
    // 课程（type 25/50/20…）：通用抓取
    const items = await genericCatalog(course, []);
    const groups = new Map();
    for (const it of items) {
      const g = it.colTitle || course.title;
      if (!groups.has(g)) groups.set(g, { colTitle: g, colRid: course.rid, videos: [] });
      groups.get(g).videos.push({ rid: it.rid, title: it.title, type: 3 });
    }
    if (!groups.size) throw new Error('未能解析该课程目录（type=' + course.type + '），请把课程链接发给作者适配');
    videos.push(...groups.values());
  }
  let flat = [];
  for (const col of videos) {
    for (const v of col.videos) {
      if (v.type !== 3) continue; // 只要视频
      flat.push({ rid: v.rid, title: v.title, colTitle: col.colTitle, colRid: col.colRid, app_id: course.app_id, courseTitle: course.title, shopOrigin: origin });
    }
  }
  // 常规接口没拿到东西时，用通用抓取兜底
  if (!flat.length && course.type !== 3) {
    try {
      const items = await genericCatalog(course, []);
      flat = items.map(it => ({ rid: it.rid, title: it.title, colTitle: it.colTitle || course.title,
        colRid: course.rid, app_id: course.app_id, courseTitle: course.title, shopOrigin: origin }));
    } catch (_) {}
  }
  state.videos[course.rid] = flat;
  return flat;
}

// 强制走通用解析（忽略缓存）
async function forceGenericCatalog(course) {
  const page = await ensureShopPage(course);
  const origin = new URL(page.url()).origin;
  const items = await genericCatalog(course, []);
  const flat = items.map(it => ({ rid: it.rid, title: it.title, colTitle: it.colTitle || course.title,
    colRid: course.rid, app_id: course.app_id, courseTitle: course.title, shopOrigin: origin }));
  state.videos[course.rid] = flat;
  return flat;
}

// 采集单个视频的 m3u8
async function harvestVideo(v) {
  const ctx = await ensureWorker();
  let page = shopPages.get(v.app_id);
  if (!page || page.isClosed()) {
    // 自动重建店铺页（重新 SSO）
    let course = (state.courses || []).find(c => c.app_id === v.app_id && c.user_id);
    if (!course) { await fetchCourses(); course = (state.courses || []).find(c => c.app_id === v.app_id && c.user_id); }
    if (!course) throw new Error('找不到课程对应的店铺信息，请重新登录');
    page = await ensureShopPage(course);
  }
  const url = v.shopOrigin + '/p/course/video/' + v.rid + '?product_id=' + v.colRid;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(async e => {
    // 页面崩溃则重建
    try { await page.close(); } catch (_) {}
    page = await ctx.newPage();
    shopPages.set(v.app_id, page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  });
  let seg = null;
  for (let i = 0; i < 30 && !seg; i++) {
    seg = await page.evaluate(`performance.getEntriesByType('resource').map(e => e.name).find(u => u.indexOf('.ts?') >= 0 && u.indexOf('sign=') >= 0) || null`).catch(() => null);
    if (!seg) await sleep(1500);
  }
  await page.evaluate(`(() => { document.querySelectorAll('video, audio').forEach(x => { x.muted = true; x.volume = 0; x.pause(); }); })()`).catch(() => {});
  if (!seg) throw new Error('未捕获到视频流（页面未开始播放）');
  const manifest = hls.deriveManifest(seg);
  const check = await hls.validateManifest(manifest);
  if (check.status !== 200 || !check.segs) throw new Error('清单校验失败: ' + JSON.stringify(check).slice(0, 100));
  return manifest;
}

// ============ 下载队列 ============
function sanitize(s) { return s.replace(/[\\/:*?"<>|\n\r\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120); }

async function runJob(job) {
  const v = job.v;
  const j = state.jobs[v.rid];
  try {
    j.status = 'harvesting'; j.message = '正在解析视频地址';
    const manifest = await withAppLock(v.app_id, () => harvestVideo(v));
    j.status = 'downloading'; j.pct = 0; j.message = '';
    const dir = path.join(OUTDIR, sanitize(v.courseTitle), sanitize(v.colTitle));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, sanitize(v.title) + '.mp4');
    if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
      j.status = 'done'; j.message = '文件已存在，跳过'; j.file = file;
      return;
    }
    await hls.download(manifest, file, (pct, segs) => { j.pct = pct; j.message = segs + ' 段'; }, { concurrency: state.settings.segments });
    j.status = 'done'; j.file = file;
    j.size = (fs.statSync(file).size / 1048576).toFixed(1) + 'MB';
  } catch (e) {
    j.status = 'failed'; j.message = e.message.slice(0, 200);
  }
}

async function processQueue() {
  if (state.running) return;
  state.running = true;
  try {
    do {
      const n = Math.max(1, Math.min(8, parseInt(state.settings.videos, 10) || 1));
      const next = () => {
        const job = state.queue.shift();
        if (!job) return Promise.resolve();
        return runJob(job).then(next);
      };
      await Promise.all(Array.from({ length: n }, next));
    } while (state.queue.length);
  } finally {
    state.running = false;
  }
  if (state.queue.length) processQueue();
}

// ============ HTTP 服务 ============
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

function send(res, code, data, type) {
  res.writeHead(code, { 'Content-Type': type || 'application/json; charset=utf-8' });
  res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
}

function readBody(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', c => b += c);
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (e) { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  try {
    if (u.pathname === '/') return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', 'index.html')), MIME['.html']);
    if (u.pathname === '/api/login/open') {
      await openLoginWindow();
      return send(res, 200, { ok: true, windowOpen: true });
    }
    if (u.pathname === '/api/login/status') return send(res, 200, { loggedIn: state.loggedIn, windowOpen: state.windowOpen, message: state.loginMessage });
    if (u.pathname === '/api/login/close') {
      if (loginCtx) { try { await loginCtx.close(); } catch (_) {} loginCtx = null; state.windowOpen = false; }
      return send(res, 200, { ok: true });
    }
    if (u.pathname === '/api/logout') {
      state.loggedIn = false; state.courses = null; state.videos = {};
      try { fs.unlinkSync(STATE_FILE); } catch (_) {}
      try { fs.unlinkSync(COOKIES_FILE); } catch (_) {}
      if (workerCtx) { try { await workerCtx.close(); } catch (_) {} workerCtx = null; }
      for (const p of shopPages.values()) { try { p.close(); } catch (_) {} }
      shopPages.clear();
      // 清空 profile 重新登录
      exec('rd /s /q "' + PROFILE + '" & rd /s /q "' + PROFILE_LOGIN + '"', { shell: 'cmd.exe' }, () => {});
      return send(res, 200, { ok: true });
    }
    if (u.pathname === '/api/courses') {
      if (!state.loggedIn) return send(res, 400, { error: '未登录' });
      if (u.searchParams.get('refresh') === '1' || !state.courses) await fetchCourses();
      return send(res, 200, { courses: state.courses });
    }
    if (u.pathname === '/api/course/videos' && req.method === 'POST') {
      const body = await readBody(req);
      const course = (state.courses || []).find(c => c.rid === body.rid);
      if (!course) return send(res, 404, { error: '课程不存在' });
      const videos = body.force ? await forceGenericCatalog(course) : await fetchCourseVideos(course);
      return send(res, 200, { videos });
    }
    if (u.pathname === '/api/catalog/probe' && req.method === 'POST') {
      const body = await readBody(req);
      const course = (state.courses || []).find(c => c.rid === body.rid);
      if (!course) return send(res, 404, { error: '课程不存在' });
      const log = [];
      const items = await genericCatalog(course, log).catch(e => { log.push({ url: 'ERROR', body: e.message }); return []; });
      return send(res, 200, { type: course.type, count: items.length, items: items.slice(0, 300), log: log.slice(0, 40) });
    }
    if (u.pathname === '/api/download' && req.method === 'POST') {
      const body = await readBody(req);
      for (const v of body.videos || []) {
        if (state.jobs[v.rid] && (state.jobs[v.rid].status === 'downloading' || state.jobs[v.rid].status === 'harvesting' || state.jobs[v.rid].status === 'done')) continue;
        state.jobs[v.rid] = { title: v.title, course: v.courseTitle, col: v.colTitle, status: 'queued', pct: 0, message: '', v };
        state.queue.push({ v });
      }
      processQueue().catch(e => console.error('queue err', e));
      return send(res, 200, { ok: true, queued: (body.videos || []).length });
    }
    if (u.pathname === '/api/settings') {
      if (req.method === 'POST') {
        const body = await readBody(req);
        const clamp = (v, d, max) => Math.max(1, Math.min(max, parseInt(v, 10) || d));
        state.settings = {
          videos: clamp(body.videos, state.settings.videos, 8),
          segments: clamp(body.segments, state.settings.segments, 16),
        };
        try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(state.settings, null, 2)); } catch (_) {}
      }
      return send(res, 200, { settings: state.settings });
    }
    if (u.pathname === '/api/dldir') return send(res, 200, { dir: OUTDIR });
    if (u.pathname === '/api/progress') {
      return send(res, 200, { jobs: state.jobs, loggedIn: state.loggedIn, queueLen: state.queue.length, running: state.running });
    }
    if (u.pathname === '/api/retry' && req.method === 'POST') {
      const body = await readBody(req);
      const j = state.jobs[body.rid];
      if (!j || !j.v) return send(res, 404, { error: '任务不存在' });
      j.status = 'queued'; j.pct = 0; j.message = '';
      state.queue.push({ v: j.v });
      processQueue().catch(() => {});
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error('[api]', e.message);
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('小鹅通课程下载工具已启动: http://127.0.0.1:' + PORT);
  exec('start http://127.0.0.1:' + PORT, { shell: 'cmd.exe' });
});
