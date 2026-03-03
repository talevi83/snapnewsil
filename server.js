require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const OpenAI = require('openai');
const Parser = require('rss-parser');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');

const app = express();
const PORT = process.env.PORT || 3000;

// OpenAI client is optional — only used for AI summaries
let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

// ─── Security headers ────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── Simple in-memory rate limiter ───────────────────────────────────────────
const rateLimitMap = new Map();
function rateLimit(windowMs, maxRequests) {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const key = `${ip}:${req.route?.path || req.path}`;
    const now = Date.now();
    let entry = rateLimitMap.get(key);
    if (!entry || now - entry.start > windowMs) {
      entry = { start: now, count: 0 };
      rateLimitMap.set(key, entry);
    }
    entry.count++;
    if (entry.count > maxRequests) {
      return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    }
    next();
  };
}
// Cleanup stale entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.start > 300_000) rateLimitMap.delete(key);
  }
}, 300_000);

// ─── SSRF protection — block private/internal IPs ────────────────────────────
const { URL } = require('url');
const net = require('net');
function isPrivateHostname(hostname) {
  if (net.isIP(hostname)) {
    const parts = hostname.split('.').map(Number);
    // 127.x.x.x, 10.x.x.x, 192.168.x.x, 172.16-31.x.x, 0.0.0.0, 169.254.x.x
    if (parts[0] === 127) return true;
    if (parts[0] === 10) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    // IPv6-mapped
    if (hostname === '::1' || hostname === '::') return true;
  }
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
  return false;
}

// ─── RSS setup ────────────────────────────────────────────────────────────────
const rssParser = new Parser({
  timeout: 8000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SnapNewsIL/1.0)' },
  customFields: { item: [['media:content', 'mediaContent'], ['media:thumbnail', 'mediaThumbnail']] },
});

const CATEGORY_FEEDS = {
  all: [
    { url: 'https://www.ynet.co.il/Integration/StoryRss2.xml', name: 'Ynet' },
    { url: 'https://rss.walla.co.il/feed/1', name: 'Walla' },
    { url: 'https://www.n12.co.il/rss/articles/news.xml', name: 'N12' },
    { url: 'https://www.maariv.co.il/rss/rsschadashot', name: 'מעריב' },
    { url: 'https://www.israelhayom.co.il/rss.xml', name: 'ישראל היום' },
  ],
  politics: [
    { url: 'https://www.maariv.co.il/rss/rssfeedspolitimedini', name: 'מעריב' },
    { url: 'https://rss.walla.co.il/feed/9', name: 'Walla' },
  ],
  security: [
    { url: 'https://www.maariv.co.il/rss/rssfeedszavavebetachon', name: 'מעריב' },
    { url: 'https://www.n12.co.il/rss/articles/news.xml', name: 'N12' },
    { url: 'https://rss.walla.co.il/feed/2642', name: 'Walla' },
  ],
  economy: [
    { url: 'https://www.calcalist.co.il/GeneralRSS.aspx', name: 'כלכליסט' },
    { url: 'https://www.globes.co.il/CommonFiles/Rss/RssGlobes.aspx', name: 'גלובס' },
    { url: 'https://www.themarker.com/srv/tm-news', name: 'TheMarker' },
    { url: 'https://www.ynet.co.il/Integration/StoryRss6.xml', name: 'Ynet' },
    { url: 'https://rss.walla.co.il/feed/3', name: 'Walla' },
    { url: 'https://www.maariv.co.il/rss/rssfeedsasakim', name: 'מעריב' },
  ],
  diplomacy: [
    { url: 'https://www.ynet.co.il/Integration/StoryRss3171.xml', name: 'Ynet' },
    { url: 'https://www.israelhayom.co.il/rss.xml', name: 'ישראל היום' },
    { url: 'https://rss.walla.co.il/feed/22', name: 'Walla' },
  ],
  society: [
    { url: 'https://rss.walla.co.il/feed/11', name: 'Walla' },
    { url: 'https://www.ynet.co.il/Integration/StoryRss17.xml', name: 'Ynet' },
    { url: 'https://www.maariv.co.il/rss/rssfeedsvariety', name: 'מעריב' },
  ],
  technology: [
    { url: 'https://www.maariv.co.il/rss/rssfeedstechnologeya', name: 'מעריב' },
    { url: 'https://rss.walla.co.il/feed/4', name: 'Walla' },
    { url: 'https://www.ynet.co.il/Integration/StoryRss544.xml', name: 'Ynet' },
    { url: 'https://www.themarker.com/srv/tm-technation', name: 'TheMarker' },
  ],
  ai: [
    { url: 'https://www.maariv.co.il/rss/rssfeedstechnologeya', name: 'מעריב' },
    { url: 'https://rss.walla.co.il/feed/4', name: 'Walla' },
    { url: 'https://www.ynet.co.il/Integration/StoryRss544.xml', name: 'Ynet' },
    { url: 'https://www.themarker.com/srv/tm-technation', name: 'TheMarker' },
  ],
  world: [
    { url: 'https://feeds.bbci.co.uk/news/world/rss.xml', name: 'BBC' },
    { url: 'https://feeds.foxnews.com/foxnews/world', name: 'Fox News' },
    { url: 'http://rss.cnn.com/rss/edition_world.rss', name: 'CNN' },
    { url: 'https://www.aljazeera.com/xml/rss/all.xml', name: 'Al Jazeera' },
    { url: 'https://www.theguardian.com/world/rss', name: 'The Guardian' },
    { url: 'https://feeds.skynews.com/feeds/rss/world.xml', name: 'Sky News' },
    { url: 'https://feeds.apnews.com/rss/apf-topnews', name: 'AP' },
  ],
  world_israel: [] // Handled separately by NewsAPI endpoint
};

// Keywords for AI-tab filtering (title or description must contain at least one)
const AI_KEYWORDS = [
  'בינה מלאכותית', 'AI', 'ChatGPT', 'GPT', 'LLM', 'מודל שפה',
  'OpenAI', 'Claude', 'Gemini', 'Copilot', 'machine learning', 'deep learning',
];

function normalizeRssItem(item, feedName) {
  let image =
    item.enclosure?.url ||
    item.mediaContent?.$.url ||
    item.mediaThumbnail?.$.url ||
    null;

  if (!image && item.content) {
    const match = item.content.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (match && match[1]) {
      image = match[1];
    }
  }

  return {
    title: (item.title || '').trim(),
    description: (item.contentSnippet || item.summary || '').substring(0, 300),
    content: item.content || '',
    url: item.link || item.url || '',
    urlToImage: image,
    publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
    source: feedName,
  };
}

// Jaccard similarity on words ≥ 3 chars (Hebrew + English)
function titleSimilarity(t1, t2) {
  const words = s => new Set(
    s.toLowerCase().replace(/[^\u0590-\u05FFa-z0-9\s]/g, '').split(/\s+/).filter(w => w.length >= 3)
  );
  const w1 = words(t1), w2 = words(t2);
  if (!w1.size || !w2.size) return 0;
  const common = [...w1].filter(w => w2.has(w)).length;
  return common / Math.max(w1.size, w2.size);
}

// Group articles that cover the same story (similar title within 12h)
function groupByStory(articles) {
  const groups = [], used = new Set();
  for (let i = 0; i < articles.length; i++) {
    if (used.has(i)) continue;
    const primary = articles[i];
    const sources = [{ name: primary.source, url: primary.url, title: primary.title }];
    used.add(i);
    for (let j = i + 1; j < articles.length; j++) {
      if (used.has(j)) continue;
      const timeDiff = Math.abs(new Date(primary.publishedAt) - new Date(articles[j].publishedAt));
      if (timeDiff > 12 * 3_600_000) continue;                            // 12h window
      if (titleSimilarity(primary.title, articles[j].title) < 0.35) continue;
      sources.push({ name: articles[j].source, url: articles[j].url, title: articles[j].title });
      used.add(j);
    }
    // Prefer an article with an image as the display primary
    const bestImage = sources
      .map(s => articles.find(a => a.url === s.url))
      .find(a => a?.urlToImage)?.urlToImage || primary.urlToImage;

    groups.push({ ...primary, urlToImage: bestImage, sources });
  }
  return groups;
}

// Israeli domains to exclude when showing international coverage
const ISRAELI_DOMAINS = [
  'haaretz.com', 'timesofisrael.com', 'jpost.com', 'ynetnews.com',
  'israelhayom.com', 'i24news.tv', 'arutzsheva.com', 'israelnationalnews.com',
  'walla.co.il', 'mako.co.il', 'kan.org.il', 'calcalist.co.il', 'globes.co.il',
].join(',');

// ─── GET /api/news ────────────────────────────────────────────────────────────
// Used for "World View Israel" - fetches international coverage mentioning Israel
app.get('/api/news', async (req, res) => {
  const { page = 1, q = 'Israel', lang = 'en' } = req.query;

  if (!process.env.NEWS_API_KEY) {
    return res.status(500).json({ error: 'NEWS_API_KEY is not set in .env' });
  }

  try {
    const params = {
      language: lang,
      sortBy: 'publishedAt',
      pageSize: 12,
      page: parseInt(page, 10),
      apiKey: process.env.NEWS_API_KEY,
      qInTitle: q,
      excludeDomains: ISRAELI_DOMAINS
    };

    const response = await axios.get('https://newsapi.org/v2/everything', { params });

    const articles = response.data.articles
      .filter(a => a.title && a.title !== '[Removed]' && a.description)
      .map((a, i) => ({
        id: `news-p${page}-${i}`,
        title: a.title,
        description: a.description,
        content: a.content,
        url: a.url,
        urlToImage: a.urlToImage,
        publishedAt: a.publishedAt,
        source: a.source?.name || 'Unknown',
        author: a.author,
      }));

    res.json({ articles, totalResults: response.data.totalResults, pageSize: 12 });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error('NewsAPI error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ─── scrapeArticle helper ────────────────────────────────────────────────────
async function scrapeArticle(url) {
  if (!url) return null;
  try {
    const response = await axios.get(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      maxRedirects: 5,
    });
    const $ = cheerio.load(response.data);

    // Strip noise before extracting paragraphs
    $('script, style, noscript, nav, header, footer, aside, ' +
      '[class*="ad-"], [class*="ads-"], [id*="ad-"], [id*="ads-"], ' +
      '[class*="social"], [class*="share"], [class*="comment"], ' +
      '[class*="related"], [class*="sidebar"], [class*="newsletter"], [class*="subscribe"], ' +
      '[class*="taboola"], [id*="taboola"], [class*="outbrain"], [class*="ob-"], ' +
      '[class*="marketing"], [class*="promoted"], [class*="recommended"], ' +
      // Israel Hayom specific ad/promo selectors
      '[class*="promo"], [class*="Promo"], [class*="banner"], [class*="Banner"], ' +
      '[class*="sponsor"], [class*="Sponsor"], [class*="native-ad"], ' +
      '[class*="commercial"], [class*="Commercial"], [class*="dfp"], ' +
      '[class*="google-ad"], [class*="googleAd"], [class*="adunit"], ' +
      '[class*="innerad"], [class*="mid-article-ad"], ' +
      '[data-ad], [data-advertisement], [data-sponsor]'
    ).remove();

    // Selectors tried in priority order; pick first yielding >= 2 paragraphs > 40 chars
    const SELECTORS = [
      'article p',
      '[class*="article-body"] p', '[class*="article-content"] p',
      '[class*="article_body"] p', '[class*="article_content"] p',
      '[class*="ArticleBody"] p', '[class*="ArticleContent"] p',
      '[class*="story-body"] p', '[class*="story-content"] p',
      '[class*="post-content"] p', '[class*="entry-content"] p',
      'main p',
    ];

    // Common Hebrew/English ad patterns to filter out of paragraphs
    const AD_PARAGRAPH_RE = /קוד קופון|הנחה מיוחדת|לרכישה\s*לחצו|לרכישה\s*הקליקו|sponsored|advertisement|שיתוף פעולה מסחרי|בשיתוף עם|תוכן שיווקי|תוכן ממומן|פרסומת|הטבה בלעדית|מבצע מיוחד|לפרטים נוספים והזמנה|להצטרפות חייגו|למימוש ההטבה|צילום:\s*יח"צ|קרדיט תמונה|באדיבות החברה|צילום באדיבות/i;

    const extract = sel =>
      $(sel).map((_, el) => $(el).text().trim()).get()
        .filter(t => t.length > 40 && !AD_PARAGRAPH_RE.test(t));

    let paragraphs = [];
    for (const sel of SELECTORS) {
      const found = extract(sel);
      if (found.length >= 2) { paragraphs = found; break; }
    }
    if (paragraphs.length < 2) paragraphs = extract('p');   // final fallback
    if (!paragraphs.length) return null;

    return paragraphs.join('\n\n').substring(0, 4000);
  } catch (err) {
    console.warn(`scrapeArticle failed [${url}]:`, err.message);
    return null;
  }
}

// ─── POST /api/summarize ──────────────────────────────────────────────────────
app.post('/api/summarize', rateLimit(60_000, 15), async (req, res) => {
  if (!openai) {
    return res.status(503).json({
      error: 'AI summaries are not enabled. OPENAI_API_KEY is not set.',
    });
  }

  const { id, title, description, content, url, lang = 'he', sentences = 3 } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  const scrapedText = await scrapeArticle(url);
  const context = scrapedText && scrapedText.length > 100
    ? scrapedText
    : [title, description, content?.replace(/\[\+\d+ chars\]$/, '')]
      .filter(Boolean)
      .join('\n\n');

  const n = Math.min(10, Math.max(2, parseInt(sentences, 10) || 3));
  const systemPrompt = lang === 'he'
    ? `אתה מסכם חדשות. השב ב-${n} משפטים עובדתיים וניטרליים בעברית ללא מספור. אם אין מספיק תוכן, כתוב פחות לפי הצורך. התעלם לחלוטין מתוכן פרסומי, שיווקי או ממומן — סכם רק את הידיעה החדשותית.`
    : `You are a news summarizer. Respond with ${n} neutral, factual sentences in English. Do not number the sentences. If there is not enough content, use fewer sentences as needed. Completely ignore any advertising, marketing, or sponsored content — summarize only the news story.`;
  const userPrompt = lang === 'he'
    ? `סכם את כתבת החדשות הבאה בעברית:\n\n${context}`
    : `Summarize this news article:\n\n${context}`;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: Math.max(200, n * 55),
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }, { timeout: 30000 });

    const summary = completion.choices[0].message.content;
    res.json({ summary });
  } catch (err) {
    console.error('OpenAI error:', err.message);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

// ─── POST /api/translate ──────────────────────────────────────────────────────
app.post('/api/translate', rateLimit(60_000, 10), async (req, res) => {
  if (!openai) {
    return res.status(503).json({ error: 'OPENAI_API_KEY not set' });
  }

  const { articles, targetLang } = req.body;
  if (!Array.isArray(articles) || !targetLang) {
    return res.status(400).json({ error: 'articles[] and targetLang required' });
  }
  if (articles.length > 30) {
    return res.status(400).json({ error: 'Too many articles — max 30 per request' });
  }

  const LANG_NAMES = {
    he: 'Hebrew', en: 'English', ar: 'Arabic',
    ru: 'Russian', fr: 'French', es: 'Spanish', de: 'German',
  };
  const targetName = LANG_NAMES[targetLang] || targetLang;

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      max_tokens: 4000,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: `You are a professional news translator. Translate article titles and descriptions to ${targetName}.
Return JSON: {"translations":[{"id":"...","title":"...","description":"..."},...]}
Keep the same order and IDs. Preserve proper nouns where culturally appropriate.`,
        },
        {
          role: 'user',
          content: JSON.stringify(
            articles.map(a => ({ id: a.id, title: a.title, description: a.description || '' }))
          ),
        },
      ],
    }, { timeout: 45000 });

    const parsed = JSON.parse(completion.choices[0].message.content);
    const results = {};
    for (const t of parsed.translations) {
      results[t.id] = { title: t.title, description: t.description };
    }
    res.json({ translations: results });
  } catch (err) {
    console.error('Translation error:', err.message);
    return res.status(500).json({ error: 'Translation failed' });
  }
});

// ─── GET /api/config-status ───────────────────────────────────────────────────
app.get('/api/config-status', (req, res) => {
  res.json({ openaiKeySet: !!openai });
});

// ─── POST /api/save-key ───────────────────────────────────────────────────────
app.post('/api/save-key', (req, res) => {
  const { key } = req.body;
  if (!key || !key.startsWith('sk-')) {
    return res.status(400).json({ error: 'Invalid key — must start with sk-' });
  }

  const envPath = path.join(__dirname, '.env');
  let envContent = '';
  try { envContent = fs.readFileSync(envPath, 'utf8'); } catch (_) { /* file may not exist */ }

  if (/^OPENAI_API_KEY=/m.test(envContent)) {
    envContent = envContent.replace(/^OPENAI_API_KEY=.*/m, `OPENAI_API_KEY=${key}`);
  } else {
    envContent = envContent.trimEnd() + `\nOPENAI_API_KEY=${key}\n`;
  }

  try {
    fs.writeFileSync(envPath, envContent, 'utf8');
  } catch (err) {
    return res.status(500).json({ error: 'Could not write .env file: ' + err.message });
  }

  // Apply immediately — no restart needed
  process.env.OPENAI_API_KEY = key;
  openai = new OpenAI({ apiKey: key });

  res.json({ success: true });
});

// ─── GET /api/img-proxy ───────────────────────────────────────────────────────
// Fetches remote images server-side, bypassing hotlink / Referer checks on news sites.
app.get('/api/img-proxy', rateLimit(60_000, 60), async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).send('Invalid url'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).send('Bad protocol');
  if (isPrivateHostname(parsed.hostname)) return res.status(403).send('Blocked host');

  try {
    const response = await axios.get(url, {
      responseType: 'stream',
      timeout: 8000,
      maxContentLength: 10 * 1024 * 1024,  // 10 MB limit
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Referer': `${parsed.protocol}//${parsed.host}/`,   // appear to come from the image's own site
      },
    });
    const ct = (response.headers['content-type'] || 'image/jpeg').split(';')[0].trim();
    if (!ct.startsWith('image/')) return res.status(415).send('Not an image');

    const isGifOrSvg = ct === 'image/gif' || ct === 'image/svg+xml';
    res.setHeader('Content-Type', isGifOrSvg ? ct : 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=86400');   // cache 24 h in browser

    response.data.on('error', streamErr => {
      console.error('Image proxy stream error:', streamErr.message);
      if (!res.headersSent) res.status(502);
      res.end();
    });

    if (!isGifOrSvg) {
      // Mechanism to reduce oversized images while maintaining aspect ratio
      const transformer = sharp()
        .resize({
          width: 800,
          height: 800,
          fit: sharp.fit.inside,
          withoutEnlargement: true
        })
        .webp({ quality: 80 });

      transformer.on('error', err => {
        console.error('Sharp error:', err.message);
        if (!res.headersSent) res.status(502);
        res.end();
      });

      response.data.pipe(transformer).pipe(res);
    } else {
      response.data.pipe(res);
    }
  } catch (err) {
    if (!res.headersSent) res.status(502).send('Could not fetch image');
  }
});

// ─── GET /api/scrape-image ────────────────────────────────────────────────────
// Scrapes an article URL to find its og:image, then redirects to img-proxy
app.get('/api/scrape-image', rateLimit(60_000, 60), async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Missing url');
  try {
    const parsedScrape = new URL(url);
    if (isPrivateHostname(parsedScrape.hostname)) return res.status(403).send('Blocked host');
    const response = await axios.get(url, {
      timeout: 8000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml'
      },
      maxRedirects: 3
    });
    const $ = cheerio.load(response.data);
    let img = $('meta[property="og:image"]').attr('content') ||
      $('meta[name="twitter:image"]').attr('content') ||
      $('meta[property="twitter:image"]').attr('content') ||
      $('meta[name="twitter:image:src"]').attr('content') ||
      $('meta[itemprop="image"]').attr('content') ||
      $('link[rel="image_src"]').attr('href');

    // First fallback: find largest image in article
    if (!img) {
      let maxArea = 0;
      $('img').each((i, el) => {
        const src = $(el).attr('src');
        if (!src) return;
        // Basic heuristic: ignore small icons or trackers
        const srcLower = src.toLowerCase();
        if (srcLower.includes('icon') || srcLower.includes('avatar') || srcLower.includes('logo') || srcLower.includes('pixel') || srcLower.includes('tracker') || srcLower.includes('1x1')) return;
        const w = parseInt($(el).attr('width') || '0', 10);
        const h = parseInt($(el).attr('height') || '0', 10);
        const area = w * h;
        if (area > maxArea && area > 10000) { // e.g., > 100x100
          maxArea = area;
          img = src;
        } else if (!img && src.match(/\.(jpe?g|png|webp)/i)) {
          // If no large image found yet, pick the first valid-looking image
          img = src;
        }
      });
    }

    if (img) {
      // Resolve relative URLs using base URL
      if (!img.startsWith('http')) {
        const parsedUrl = new URL(url);
        img = new URL(img, parsedUrl.origin).href;
      }
      return res.redirect(`/api/img-proxy?url=${encodeURIComponent(img)}`);
    }
    return res.status(404).send('No image meta tag found');
  } catch (err) {
    return res.status(502).send('Scrape failed');
  }
});

// ─── GET /api/rss ─────────────────────────────────────────────────────────────
app.get('/api/rss', async (req, res) => {
  const { page = 1, category = 'all' } = req.query;
  const PAGE_SIZE = 12;
  const feeds = CATEGORY_FEEDS[category] || CATEGORY_FEEDS.all;

  try {
    const results = await Promise.allSettled(
      feeds.map(f =>
        rssParser.parseURL(f.url).then(feed =>
          feed.items.map(item => normalizeRssItem(item, f.name))
        )
      )
    );
    let articles = [];
    results.forEach(r => { if (r.status === 'fulfilled') articles.push(...r.value); });

    // Ad and sponsored content filtering keywords (English + Hebrew)
    const AD_KEYWORDS = /\b(APR|credit card|home equity|cash|refinance|mortgage|loan|sponsored|promoted|intro|0%|invest|insurance)\b|תוכן שיווקי|תוכן ממומן|בשיתוף פעולה מסחרי|פרסומת|מודעה/i;

    articles = articles
      .filter(a => a.title && a.url && !AD_KEYWORDS.test(a.title))
      .sort((a, b) => {
        const timeA = new Date(a.publishedAt).getTime();
        const timeB = new Date(b.publishedAt).getTime();
        return (isNaN(timeB) ? 0 : timeB) - (isNaN(timeA) ? 0 : timeA);
      });

    // AI tab: filter by keywords; fall back to all tech articles if too few results
    if (category === 'ai') {
      const filtered = articles.filter(a => {
        const text = (a.title + ' ' + (a.description || '')).toLowerCase();
        return AI_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
      });
      if (filtered.length >= 6) articles = filtered;
    }

    const groups = groupByStory(articles);
    const pageNum = Math.max(1, parseInt(page, 10));
    const paged = groups
      .slice((pageNum - 1) * PAGE_SIZE, pageNum * PAGE_SIZE)
      .map((g, i) => ({ ...g, id: `rss-${category}-p${pageNum}-${i}` }));

    res.json({ articles: paged, totalResults: groups.length, pageSize: PAGE_SIZE });
  } catch (err) {
    console.error('RSS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/synthesize-title ───────────────────────────────────────────────
app.post('/api/synthesize-title', rateLimit(60_000, 15), async (req, res) => {
  if (!openai) return res.status(503).json({ error: 'OpenAI not configured' });
  const { sources } = req.body;   // [{name, title}]
  if (!Array.isArray(sources) || sources.length < 2)
    return res.status(400).json({ error: 'Need at least 2 sources' });
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o', max_tokens: 60,
      messages: [
        {
          role: 'system',
          content: 'אתה עורך חדשות. כתוב כותרת ניטרלית ותמציתית בעברית (עד 12 מילים) שמסכמת את הידיעה על פי הכותרות הבאות ממקורות שונים. עובדות בלבד, ללא פרשנות.',
        },
        {
          role: 'user',
          content: sources.map(s => `${s.name}: ${s.title}`).join('\n'),
        },
      ],
    }, { timeout: 15000 });
    res.json({ title: completion.choices[0].message.content.trim() });
  } catch (err) {
    console.error('Synthesize error:', err.message);
    res.status(500).json({ error: 'Synthesis failed' });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────┐
  │   🇮🇱  Israel News App              │
  │   http://localhost:${PORT}              │
  └─────────────────────────────────────┘
  `);
});
