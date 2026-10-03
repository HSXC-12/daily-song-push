// recommend.mjs — 每日推歌（云端版）
// 流程：DeepSeek 生成 5 首 → B站搜索+官方核验链接 → 邮件发送 → 更新 history.json 去重
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(__dirname, 'history.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TZ = 'Asia/Shanghai';

// ---------- 工具 ----------
function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function daysAgo(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const then = Date.UTC(y, m - 1, d);
  const now = todayStr().split('-').map(Number);
  const nowUtc = Date.UTC(now[0], now[1] - 1, now[2]);
  return Math.round((nowUtc - then) / 86400000);
}
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtViews = (v) => (v >= 10000 ? (v / 10000).toFixed(1) + '万' : String(v));
const stripHtml = (s) => String(s).replace(/<[^>]+>/g, '').trim();

// ---------- B站 wbi 签名 ----------
const mixinKeyEncTab = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const getMixinKey = (orig) => mixinKeyEncTab.map((n) => orig[n]).join('').slice(0, 32);

async function biliFetch(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' } });
  if (!res.ok) throw new Error(`bilibili HTTP ${res.status} for ${url}`);
  return res.json();
}

let wbiKeys = null;
async function getWbiKeys() {
  if (wbiKeys) return wbiKeys;
  const j = await biliFetch('https://api.bilibili.com/x/web-interface/nav');
  const img = j.data.wbi_img.img_url;
  const sub = j.data.wbi_img.sub_url;
  wbiKeys = {
    imgKey: img.slice(img.lastIndexOf('/') + 1).split('.')[0],
    subKey: sub.slice(sub.lastIndexOf('/') + 1).split('.')[0],
  };
  return wbiKeys;
}

function encWbi(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey + subKey);
  const withWts = { ...params, wts: Math.round(Date.now() / 1000) };
  const query = Object.keys(withWts).sort().map((key) => {
    const value = String(withWts[key]).replace(/[!'()*]/g, '');
    return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }).join('&');
  const w_rid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${w_rid}`;
}

async function biliSearch(keyword) {
  const { imgKey, subKey } = await getWbiKeys();
  const query = encWbi({ keyword, search_type: 'video', page: 1 }, imgKey, subKey);
  const j = await biliFetch('https://api.bilibili.com/x/web-interface/search/type?' + query);
  if (j.code !== 0) throw new Error(`bili search failed: ${j.code} ${j.message}`);
  return (j.data?.result || []).map((r) => ({ bvid: r.bvid, title: stripHtml(r.title), author: r.author }));
}

async function biliView(bvid) {
  const j = await biliFetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`);
  if (j.code !== 0) return null;
  const d = j.data;
  return { bvid, title: d.title, owner: d.owner?.name || '', views: d.stat?.view || 0, copyright: d.copyright };
}

// ---------- 链接选择：官方优先，排除翻唱/剧情版/剪辑 ----------
const OFFICIAL_HINTS = ['官方', 'official', '音乐', 'music', 'hoyo-mix', 'hoyomix'];
const BAD_HINTS = ['翻唱', 'cover', 'remix', '混剪', '剪辑', '高清修复', '录音棚', '剧情版', '饭拍', '现场', 'live', '伴奏'];

function scoreCandidate(song, info) {
  const t = info.title.toLowerCase();
  const title = song.title.toLowerCase();
  const fullHit = t.includes(title) || title.includes(t);
  if (!fullHit) return -1;
  if (BAD_HINTS.some((h) => info.title.toLowerCase().includes(h))) return -1; // 剧情版/翻唱等直接淘汰
  let s = 10;
  const owner = (info.owner || '').toLowerCase();
  const artist = (song.artist || '').toLowerCase();
  if (artist && (owner.includes(artist) || artist.includes(owner))) s += 8;
  if (OFFICIAL_HINTS.some((h) => (info.owner || '').toLowerCase().includes(h))) s += 5;
  if (info.copyright === 1) s += 2;
  s += Math.min(info.views / 200000, 8);
  return s;
}

async function findLink(song) {
  const kw = `${song.title} ${song.artist}`.trim();
  const results = await biliSearch(kw);
  let best = null;
  let bestScore = 0;
  for (const r of results.slice(0, 8)) {
    const info = await biliView(r.bvid);
    if (!info) continue;
    const sc = scoreCandidate(song, info);
    if (sc > bestScore) { bestScore = sc; best = { ...info, score: sc }; }
  }
  if (best && bestScore >= 10) {
    const owner = (best.owner || '').toLowerCase();
    const official = OFFICIAL_HINTS.some((h) => owner.includes(h)) || (song.artist && owner.includes((song.artist || '').toLowerCase()));
    return { url: `https://www.bilibili.com/video/${best.bvid}/`, label: official ? '官方版' : '原曲', owner: best.owner, views: best.views };
  }
  return { url: `https://search.bilibili.com/all?keyword=${encodeURIComponent(kw)}`, label: '搜索页(未找到可靠原曲)', owner: '', views: 0 };
}

// ---------- DeepSeek 生成 ----------
const SYSTEM_PROMPT = `你是「每日推歌」助手。根据用户的种子音乐与口味基准，每天推荐 5 首歌。

【种子音乐与口味基准】
- 《野马尘埃 Floating Mist》阿兰/HOYO-MiX（原神）：空灵大气的华语游戏人声、史诗管弦
- 《挪德卡莱 Nod-Krai》AURORA/HOYO-MiX（原神）：北欧空灵女声、电影感编排
- 《Saving Grace》KIRBY（Spider-Noir 插曲）：影视 OST、灵魂感强嗓音、cinematic
- 《覆灭重生 Come Alive》Philip Strand/雷声（绝区零 OP）：摇滚/电子、爆发力燃系人声
- 《最炫民族风》凤凰传奇：华语民族风流行、欢快洗脑、气氛担当
口味基准：游戏/影视 OST 级制作、强辨识度人声（空灵女声或燃系摇滚嗓）、宏大或高能量编曲；另有一条「欢快华语流行」的快乐轴。更广偏好：华语流行、欧美流行/摇滚、HoYoMix 游戏音乐。

【硬性规则】
1. 5 首中 4 首贴合口味基准，1 首为随机惊喜（风格迥异）；惊喜约每 4 天一次即可。
2. 悲壮抒情/催泪类 OST（如《Nightglow》）最多每周推荐 1 次；若「最近7天已推分类」里已有此类，本次不要选。
3. 不要重复「最近已推」里的歌；尽量选用户大概率没听过的新歌/新发行。
4. 不推种子本身，但可推同艺人/同系列其他作品。
5. 每首歌给出：语种与风格、与种子的关联（一句话）、推荐理由（一句话）、评分(1-10，保留0.5)、听感（一句）。

【输出格式】只输出 JSON，结构如下：
{"songs":[{"title":"歌名","artist":"歌手","languageStyle":"语种与风格","seedMatch":"与种子的关联","reason":"推荐理由","rating":8.5,"impression":"听感一句话","category":"分类标签(史诗/燃系摇滚/空灵女声/电子/欢快华语/悲壮抒情/其他)"}]}`;

function userPrompt(history) {
  const recent = (history.pushed || []).slice(-30).map((e) => `${e.date} ${e.title}-${e.artist}[${e.category}]`).join('；') || '（空）';
  const last7 = (history.pushed || []).filter((e) => daysAgo(e.date) <= 7).map((e) => e.category).join('、') || '（无）';
  return `今天是 ${todayStr()}（北京时间）。\n最近已推（勿重复）：${recent}\n最近7天已推分类：${last7}\n请推荐 5 首歌，严格按 JSON 格式输出。`;
}

async function generateSongs(history) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt(history) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.8,
      max_tokens: 4000,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`DeepSeek HTTP ${res.status}: ${t.slice(0, 500)}`);
  }
  const j = await res.json();
  const content = j.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek 返回为空: ' + JSON.stringify(j).slice(0, 500));
  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error('解析 LLM JSON 失败: ' + content.slice(0, 500));
  }
}

// ---------- 邮件 ----------
function buildHtml(songs, date) {
  const rows = songs.map((s, i) => `
    <div style="margin-bottom:18px;border-left:4px solid #e50914;padding-left:12px;">
      <div style="font-size:16px;font-weight:bold;">${i + 1}⃣ 《${escapeHtml(s.title)}》— ${escapeHtml(s.artist)}</div>
      <div style="color:#555;margin-top:4px;">${escapeHtml(s.languageStyle)}｜${escapeHtml(s.seedMatch)}</div>
      <div style="color:#333;margin-top:4px;">推荐理由：${escapeHtml(s.reason)}</div>
      <div style="margin-top:4px;">在线试听：<a href="${escapeHtml(s.link.url)}">${escapeHtml(s.link.url)}</a>（${escapeHtml(s.link.label)}${s.link.views ? '，播放 ' + fmtViews(s.link.views) : ''}）</div>
      <div style="color:#e50914;margin-top:4px;">我的评分：${s.rating}/10｜听感：${escapeHtml(s.impression)}</div>
    </div>`).join('');
  return `<!DOCTYPE html><html><body style="font-family:'Microsoft YaHei',sans-serif;max-width:640px;margin:auto;padding:16px;">
    <h2 style="color:#e50914;">🎵 今日推歌（${date}）</h2>${rows}
    <hr><p style="color:#888;font-size:13px;">评分与听感由 AI 生成，仅供参考。本邮件由 GitHub Actions 每日自动发送。</p>
  </body></html>`;
}

async function sendEmail(songs, date) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== 'false', // 465 默认 SSL
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({
    from: `"每日推歌" <${process.env.SMTP_USER}>`,
    to: process.env.MAIL_TO,
    subject: `🎵 今日推歌 ${date}（5 首）`,
    html: buildHtml(songs, date),
  });
  console.log('邮件已发送到', process.env.MAIL_TO);
}

// ---------- 主流程 ----------
async function main() {
  const required = ['DEEPSEEK_API_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_TO'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('缺少环境变量:', missing.join(', '));
    process.exit(1);
  }

  const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  const data = await generateSongs(history);
  const songs = data.songs;
  if (!Array.isArray(songs) || songs.length === 0) throw new Error('LLM 未返回有效歌单');

  for (const s of songs) {
    s.link = await findLink(s);
    console.log(`[link] ${s.title} -> ${s.link.url} (${s.link.label})`);
  }

  const date = todayStr();
  await sendEmail(songs, date);

  for (const s of songs) {
    history.pushed.push({ date, title: s.title, artist: s.artist, category: s.category || '其他' });
  }
  history.pushed = history.pushed.filter((e) => daysAgo(e.date) <= 30);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2) + '\n');
  console.log('完成：', songs.map((s) => s.title).join(' / '));
}

main().catch((e) => {
  console.error('运行失败:', e.message);
  process.exit(1);
});
