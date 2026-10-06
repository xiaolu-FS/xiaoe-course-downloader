// 小鹅通已购课程下载工具 - 本地服务
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { chromium } = require('playwright-core');
const hls = require('./lib/hls');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 5273;
const ROOT = __dirname;
const PROFILE = path.join(ROOT, 'profile');
const OUTDIR = path.join(ROOT, 'downloads');
const STATE_FILE = path.join(ROOT, 'state.json');
const COOKIES_FILE = path.join(ROOT, 'cookies.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
};

// ============ Playwright 会话 ============
let loginCtx = null;   // 有头登录窗口
let workerCtx = null;  // 无头工作上下文
let studyPage = null;  // 学习中心页（复用）

async function openLoginWindow() {
  if (loginCtx) return;
  loginCtx = await chromium.launchPersistentContext(PROFILE, {
    executablePath: CHROME,
    headless: false,
    viewport: { width: 1280, height: 860 },
    args: ['--window-size=1280,860', '--mute-audio', '--disable-blink-features=AutomationControlled'],
  });
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

async function ensureWorker() {
  if (!state.loggedIn) throw new Error('未登录');
  if (!workerCtx) {
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
      col.videos = [];
      for (let p = 1; p <= 30; p++) {
        const r = await shopApi(page, '/xe.course.business_go.column.items.get/2.0.0', { column_id: col.colRid, page_index: p, page_size: 20 });
        const l = (r.data && r.data.list) || [];
        col.videos.push(...l.map(x => ({ rid: x.resource_id, title: typeof x.title === 'string' ? x.title : x.resource_title, type: x.resource_type })));
        if (!l.length || (r.data.total && col.videos.length >= r.data.total)) break;
      }
    }
  } else if (course.type === 6) {
    const col = { colTitle: course.title, colRid: course.rid, videos: [] };
    for (let p = 1; p <= 30; p++) {
      const r = await shopApi(page, '/xe.course.business_go.column.items.get/2.0.0', { column_id: course.rid, page_index: p, page_size: 20 });
      const l = (r.data && r.data.list) || [];
      col.videos.push(...l.map(x => ({ rid: x.resource_id, title: typeof x.title === 'string' ? x.title : x.resource_title, type: x.resource_type })));
      if (!l.length || (r.data.total && col.videos.length >= r.data.total)) break;
    }
    videos.push(col);
  } else if (course.type === 3) {
    videos.push({ colTitle: course.title, colRid: course.rid, videos: [{ rid: course.rid, title: course.title, type: 3 }] });
  } else {
    throw new Error('暂不支持该类型（type=' + course.type + '），仅支持视频/专栏/大专栏');
  }
  const flat = [];
  for (const col of videos) {
    for (const v of col.videos) {
      if (v.type !== 3) continue; // 只要视频
      flat.push({ rid: v.rid, title: v.title, colTitle: col.colTitle, colRid: col.colRid, app_id: course.app_id, courseTitle: course.title, shopOrigin: origin });
    }
  }
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

async function processQueue() {
  if (state.running) return;
  state.running = true;
  while (state.queue.length) {
    const job = state.queue.shift();
    const v = job.v;
    const j = state.jobs[v.rid];
    try {
      j.status = 'harvesting'; j.message = '正在解析视频地址';
      const manifest = await harvestVideo(v);
      j.status = 'downloading'; j.pct = 0; j.message = '';
      const dir = path.join(OUTDIR, sanitize(v.courseTitle), sanitize(v.colTitle));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, sanitize(v.title) + '.mp4');
      if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
        j.status = 'done'; j.message = '文件已存在，跳过'; j.file = file;
        continue;
      }
      await hls.download(manifest, file, (pct, segs) => { j.pct = pct; j.message = segs + ' 段'; });
      j.status = 'done'; j.file = file;
      j.size = (fs.statSync(file).size / 1048576).toFixed(1) + 'MB';
    } catch (e) {
      j.status = 'failed'; j.message = e.message.slice(0, 200);
    }
  }
  state.running = false;
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
      exec('rd /s /q "' + PROFILE + '"', { shell: 'cmd.exe' }, () => {});
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
      const videos = await fetchCourseVideos(course);
      return send(res, 200, { videos });
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
