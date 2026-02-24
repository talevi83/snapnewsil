require('dotenv').config();
const express = require('express');
const axios   = require('axios');
const OpenAI  = require('openai');
const Parser  = require('rss-parser');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 3000;

// OpenAI client is optional — only used for AI summaries
let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}


app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─── RSS setup ────────────────────────────────────────────────────────────────
const rssParser = new Parser({
  timeout: 8000,
  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SnapNewsIL/1.0)' },
  customFields: { item: [['media:content', 'mediaContent'], ['media:thumbnail', 'mediaThumbnail']] },
});

const RSS_FEEDS = [
  { url: 'https://www.ynet.co.il/Integration/StoryRss2.xml',       name: 'Ynet'      },
  { url: 'https://rss.walla.co.il/feed/1',                          name: 'Walla'     },
  { url: 'https://www.n12.co.il/rss/articles/news.xml',             name: 'N12'       },
  { url: 'https://www.calcalist.co.il/GeneralRSS.aspx',             name: 'Calcalist' },
  { url: 'https://www.globes.co.il/CommonFiles/Rss/RssGlobes.aspx', name: 'Globes'    },
];

function normalizeRssItem(item, feedName) {
  const image =
    item.enclosure?.url       ||
    item.mediaContent?.$.url  ||
    item.mediaThumbnail?.$.url ||
    null;
  return {
    title:       (item.title || '').trim(),
    description: (item.contentSnippet || item.summary || '').substring(0, 300),
    content:     item.content || '',
    url:         item.link || item.url || '',
    urlToImage:  image,
    publishedAt: item.isoDate || item.pubDate || new Date().toISOString(),
    source:      feedName,
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
app.get('/api/news', async (req, res) => {
  const { page = 1, q = 'ישראל', lang = 'he', international = 'false' } = req.query;

  if (!process.env.NEWS_API_KEY) {
    return res.status(500).json({ error: 'NEWS_API_KEY is not set in .env' });
  }

  try {
    const params = {
      language: lang,
      sortBy:   'publishedAt',
      pageSize: 12,
      page:     parseInt(page, 10),
      apiKey:   process.env.NEWS_API_KEY,
    };

    if (international === 'true') {
      // qInTitle guarantees "Israel" is in the headline — no post-filter needed
      params.qInTitle       = q;
      params.excludeDomains = ISRAELI_DOMAINS;
    } else {
      // Hebrew tabs: search full content, then filter to title/description mentions
      params.q = q;
    }

    const response = await axios.get('https://newsapi.org/v2/everything', { params });

    const articles = response.data.articles
      .filter(a => a.title && a.title !== '[Removed]' && a.description)
      .map((a, i) => ({
        id:          `p${page}-${i}`,
        title:       a.title,
        description: a.description,
        content:     a.content,
        url:         a.url,
        urlToImage:  a.urlToImage,
        publishedAt: a.publishedAt,
        source:      a.source?.name || 'Unknown',
        author:      a.author,
      }));

    res.json({ articles, totalResults: response.data.totalResults });
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    console.error('NewsAPI error:', msg);
    res.status(500).json({ error: msg });
  }
});

// ─── POST /api/summarize ──────────────────────────────────────────────────────
app.post('/api/summarize', async (req, res) => {
  if (!openai) {
    return res.status(503).json({
      error: 'AI summaries are not enabled. OPENAI_API_KEY is not set.',
    });
  }

  const { id, title, description, content, lang = 'he' } = req.body;
  if (!title) return res.status(400).json({ error: 'title is required' });

  const context = [title, description, content?.replace(/\[\+\d+ chars\]$/, '')]
    .filter(Boolean)
    .join('\n\n');

  const systemPrompt = lang === 'he'
    ? 'אתה מסכם חדשות תמציתי. השב אך ורק ב-2-3 משפטים עובדתיים וניטרליים בעברית.'
    : 'You are a concise news summarizer. Respond with 2-3 neutral, factual sentences in English.';
  const userPrompt = lang === 'he'
    ? `סכם את כתבת החדשות הבאה בעברית:\n\n${context}`
    : `Summarize this news article:\n\n${context}`;

  try {
    const completion = await openai.chat.completions.create({
      model:      'gpt-4o',
      max_tokens: 200,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
    });

    const summary = completion.choices[0].message.content;
    res.json({ summary });
  } catch (err) {
    console.error('OpenAI error:', err.message);
    res.status(500).json({ error: 'Failed to generate summary' });
  }
});

// ─── POST /api/translate ──────────────────────────────────────────────────────
app.post('/api/translate', async (req, res) => {
  if (!openai) {
    return res.status(503).json({ error: 'OPENAI_API_KEY not set' });
  }

  const { articles, targetLang } = req.body;
  if (!Array.isArray(articles) || !targetLang) {
    return res.status(400).json({ error: 'articles[] and targetLang required' });
  }

  const LANG_NAMES = {
    he: 'Hebrew', en: 'English', ar: 'Arabic',
    ru: 'Russian', fr: 'French', es: 'Spanish', de: 'German',
  };
  const targetName = LANG_NAMES[targetLang] || targetLang;

  try {
    const completion = await openai.chat.completions.create({
      model:           'gpt-4o',
      max_tokens:      4000,
      response_format: { type: 'json_object' },
      messages: [
        {
          role:    'system',
          content: `You are a professional news translator. Translate article titles and descriptions to ${targetName}.
Return JSON: {"translations":[{"id":"...","title":"...","description":"..."},...]}
Keep the same order and IDs. Preserve proper nouns where culturally appropriate.`,
        },
        {
          role:    'user',
          content: JSON.stringify(
            articles.map(a => ({ id: a.id, title: a.title, description: a.description || '' }))
          ),
        },
      ],
    });

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

// ─── GET /api/rss ─────────────────────────────────────────────────────────────
app.get('/api/rss', async (req, res) => {
  const { page = 1 } = req.query;
  const PAGE_SIZE = 12;
  try {
    const results = await Promise.allSettled(
      RSS_FEEDS.map(f =>
        rssParser.parseURL(f.url).then(feed =>
          feed.items.map(item => normalizeRssItem(item, f.name))
        )
      )
    );
    let articles = [];
    results.forEach(r => { if (r.status === 'fulfilled') articles.push(...r.value); });
    articles = articles
      .filter(a => a.title && a.url)
      .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    const groups  = groupByStory(articles);
    const pageNum = Math.max(1, parseInt(page, 10));
    const paged   = groups
      .slice((pageNum - 1) * PAGE_SIZE, pageNum * PAGE_SIZE)
      .map((g, i) => ({ ...g, id: `rss-p${pageNum}-${i}` }));

    res.json({ articles: paged, totalResults: groups.length, pageSize: PAGE_SIZE });
  } catch (err) {
    console.error('RSS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/synthesize-title ───────────────────────────────────────────────
app.post('/api/synthesize-title', async (req, res) => {
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
    });
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
