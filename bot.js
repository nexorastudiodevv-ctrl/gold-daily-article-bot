const sharp = require('sharp');

const CONFIG = {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  SITE_API_URL: process.env.SITE_API_URL,
  SITE_API_SECRET: process.env.SITE_API_SECRET,
  REQUEST_TIMEOUT_MS: 15000,
  TROY_OUNCE_TO_GRAMS: 31.1034768,
  PREFERRED_MODELS: [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'qwen/qwen3-32b',
    'meta-llama/llama-4-scout-17b-16e-instruct'
  ]
};

// خط الأمير للنصوص العربية في الصورة (مع خطوط احتياطية)
const CARD_FONT = 'Amiri, Noto Sans Arabic, DejaVu Sans, sans-serif';

function validateEnvironment() {
  const missing = ['GROQ_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'].filter(
    (key) => !CONFIG[key] || !CONFIG[key].trim()
  );
  if (missing.length > 0) {
    throw new Error(`متغيرات البيئة التالية مفقودة: ${missing.join(', ')}`);
  }
}

async function fetchWithRetry(url, options = {}, retries = 2, timeoutMs = CONFIG.REQUEST_TIMEOUT_MS) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (response.ok) return response;

      if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        return response;
      }
      if (attempt === retries) return response;
    } catch (err) {
      if (attempt === retries) throw err;
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
}

function getMarketSessionContext(now = new Date()) {
  const day = now.getUTCDay();
  const hour = now.getUTCHours();

  if (day === 6 || (day === 5 && hour >= 22) || (day === 0 && hour < 22)) {
    return 'عطلة نهاية الأسبوع للبورصات العالمية (استقرار سعري عند مستويات الإغلاق الأسبوعي)';
  }
  if (hour >= 0 && hour < 7) return 'الجلسة الآسيوية (تداولات طوكيو وشنغهاي)';
  if (hour >= 7 && hour < 13) return 'الجلسة الأوروبية (بورصة لندن للمعادن الثمينة)';
  if (hour >= 13 && hour < 21) return 'الجلسة الأمريكية (تداولات نيويورك كومكس وصدور البيانات الاقتصادية)';
  return 'فترة التداول الهادئة بين الإغلاق الأمريكي والافتتاح الآسيوي';
}

function formatDateLabel(rawDate) {
  const d = new Date(rawDate || Date.now());
  if (Number.isNaN(d.getTime())) return 'DAILY UPDATE';
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).toUpperCase();
}

function calculateGoldMetrics(ounceUsd, changeUsd, changePercent, rawDate, sourceName) {
  const ounce = Number(ounceUsd);
  const chg = Number(changeUsd || 0);
  const pct = Number(changePercent || 0);

  const gram24 = ounce / CONFIG.TROY_OUNCE_TO_GRAMS;
  const gram21 = gram24 * (21 / 24);
  const gram18 = gram24 * (18 / 24);

  let trend = 'استقرار نسبي';
  let trendEn = 'STABLE MARKET';
  let trendColor = '#F59E0B';
  let trendEmoji = '⚖️';

  if (pct > 0.15) {
    trend = 'صعود';
    trendEn = 'BULLISH UPTREND';
    trendColor = '#22C55E';
    trendEmoji = '📈';
  } else if (pct < -0.15) {
    trend = 'هبوط';
    trendEn = 'BEARISH DOWNTREND';
    trendColor = '#EF4444';
    trendEmoji = '📉';
  }

  return {
    available: true,
    source: sourceName,
    ounceUsd: ounce.toFixed(2),
    gram24Usd: gram24.toFixed(2),
    gram21Usd: gram21.toFixed(2),
    gram18Usd: gram18.toFixed(2),
    changeUsd: `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}`,
    changePercent: `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`,
    pctNumber: pct,
    trend,
    trendEn,
    trendColor,
    trendEmoji,
    dateLabel: formatDateLabel(rawDate),
    session: getMarketSessionContext(),
    date: rawDate || new Date().toISOString()
  };
}

async function fetchGoldData() {
  try {
    const res = await fetchWithRetry('https://data-asg.goldprice.org/dbXRates/USD', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Referer': 'https://goldprice.org/',
        'Accept': 'application/json, text/plain, */*'
      }
    });

    if (res?.ok) {
      const data = await res.json();
      const item = data.items?.[0];
      if (item?.xauPrice) {
        return calculateGoldMetrics(item.xauPrice, item.chgXau, item.pcXau, data.date, 'GoldPrice Global Feed');
      }
    }
  } catch (err) {
    console.warn(`تعذر الاتصال بالمصدر الأول (${err.message})`);
  }

  try {
    const altRes = await fetchWithRetry('https://api.gold-api.com/price/XAU', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });

    if (altRes?.ok) {
      const altData = await altRes.json();
      const price = altData.price ?? altData.xauPrice;
      if (price) {
        return calculateGoldMetrics(
          price,
          altData.ch ?? altData.change ?? 0,
          altData.chp ?? altData.change_percent ?? 0,
          altData.updatedAt || altData.timestamp,
          'Gold-API Spot'
        );
      }
    }
  } catch (err) {
    console.warn(`تعذر الاتصال بالمصدر الثاني (${err.message})`);
  }

  return {
    available: false,
    pctNumber: 0,
    trendEn: 'MARKET ANALYSIS',
    trendColor: '#F59E0B',
    dateLabel: formatDateLabel(new Date().toISOString()),
    session: getMarketSessionContext(),
    date: new Date().toISOString()
  };
}

// ───────────────────────── أدوات الرسم ─────────────────────────

const RIGHT = 1160;
const LEFT = 120;

function esc(s) {
  return String(s)
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"');
}

// تقسيم النص العربي لأسطر حسب عدد الحروف (مع اقتطاع بـ … لو زاد عن الحد)
function wrapText(text, maxChars, maxLines) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let current = '';
  for (const w of words) {
    const next = current ? `${current} ${w}` : w;
    if (next.length > maxChars && current) {
      lines.push(current);
      current = w;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) {
    const cut = lines.slice(0, maxLines);
    cut[maxLines - 1] = cut[maxLines - 1].replace(/[\s.,،:؛]*$/, '') + '…';
    return cut;
  }
  return lines;
}

function arText(x, y, size, fill, content, opts = {}) {
  const anchor = opts.anchor || 'end';
  const weight = opts.weight || 'bold';
  return `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${CARD_FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}">${esc(content)}</text>`;
}

function goldBars(x, y, s = 1) {
  const bar = (dx, dy) =>
    `<g transform="translate(${x + dx * s},${y + dy * s}) scale(${s})">` +
    `<polygon points="0,30 90,30 110,0 20,0" fill="url(#gold)"/>` +
    `<polygon points="0,30 90,30 90,62 0,62" fill="#D97706"/>` +
    `<polygon points="90,30 110,0 110,32 90,62" fill="#B45309"/></g>`;
  return bar(0, 64) + bar(100, 64) + bar(50, 0);
}

function svgShell(gold, inner) {
  return [
    `<svg width="1280" height="720" viewBox="0 0 1280 720" xmlns="http://www.w3.org/2000/svg">`,
    `<defs>`,
    `<linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#090D16"/><stop offset="55%" stop-color="#111827"/><stop offset="100%" stop-color="#1E293B"/></linearGradient>`,
    `<linearGradient id="gold" x1="0%" y1="0%" x2="100%" y2="0%"><stop offset="0%" stop-color="#FEF08A"/><stop offset="50%" stop-color="#F59E0B"/><stop offset="100%" stop-color="#D97706"/></linearGradient>`,
    `<radialGradient id="glow" cx="15%" cy="85%" r="60%"><stop offset="0%" stop-color="#F59E0B" stop-opacity="0.18"/><stop offset="100%" stop-color="#F59E0B" stop-opacity="0"/></radialGradient>`,
    `</defs>`,
    `<rect width="1280" height="720" fill="url(#bg)"/>`,
    `<rect width="1280" height="720" fill="url(#glow)"/>`,
    `<rect x="40" y="40" width="1200" height="640" rx="28" fill="#0F172A" fill-opacity="0.82" stroke="#F59E0B" stroke-opacity="0.4" stroke-width="2"/>`,
    `<rect x="1174" y="84" width="10" height="40" rx="5" fill="url(#gold)"/>`,
    arText(1156, 113, 28, '#F8FAFC', 'سهم الذهب | أسعار الذهب'),
    arText(LEFT, 113, 22, '#94A3B8', gold.dateLabel, { anchor: 'start', rtl: false }),
    `<line x1="84" y1="146" x2="1196" y2="146" stroke="#F59E0B" stroke-opacity="0.25" stroke-width="1.5"/>`,
    inner,
    arText(640, 650, 20, '#FDE047', '@sahm_elzahab', { anchor: 'middle', rtl: false }),
    `</svg>`
  ].join('\n');
}

// ───────────────────────── البطاقات ─────────────────────────

function buildCoverSvg(gold, insights) {
  const lines = wrapText(insights.headline, 34, 3);
  let inner = arText(RIGHT, 205, 24, '#F59E0B', 'تحليل اقتصادي');
  lines.forEach((line, i) => {
    inner += arText(RIGHT, 275 + i * 72, 58, '#F8FAFC', line);
  });
  const lineBottom = 275 + (lines.length - 1) * 72;
  inner += `<rect x="${RIGHT - 170}" y="${lineBottom + 24}" width="170" height="6" rx="3" fill="url(#gold)"/>`;

  inner += goldBars(LEFT, 470, 1.15);

  if (gold.available) {
    inner += `<rect x="520" y="490" width="640" height="110" rx="20" fill="#1E293B" stroke="${gold.trendColor}" stroke-opacity="0.6" stroke-width="2"/>`;
    inner += arText(1130, 535, 22, '#94A3B8', 'سعر الأونصة عالمياً');
    inner += arText(1130, 585, 50, '#FDE047', `$${gold.ounceUsd}`, { rtl: false });
    inner += arText(560, 548, 28, gold.trendColor, gold.changePercent, { anchor: 'start', rtl: false });
    inner += arText(560, 585, 22, '#E2E8F0', gold.trend, { anchor: 'start' });
  } else {
    inner += arText(RIGHT, 560, 30, '#94A3B8', insights.outlook ? 'تقرير يومي عن حركة الذهب' : '');
  }
  return svgShell(gold, inner);
}

function buildPricesSvg(gold) {
  const ounceText = gold.available ? `$${gold.ounceUsd}` : 'سعر الذهب';
  const changeText = gold.available ? `${gold.changeUsd}$ (${gold.changePercent})` : 'تقرير يومي';
  const g24 = gold.available ? `$${gold.gram24Usd}` : '--';
  const g21 = gold.available ? `$${gold.gram21Usd}` : '--';
  const g18 = gold.available ? `$${gold.gram18Usd}` : '--';

  let trendAr = 'استقرار نسبي';
  if (gold.available && gold.pctNumber > 0.15) trendAr = 'صعود السوق';
  else if (gold.available && gold.pctNumber < -0.15) trendAr = 'هبوط السوق';

  let inner = '';
  inner += arText(1156, 205, 22, '#F59E0B', 'سعر الأونصة عالمياً (دولار)');
  inner += `<text x="1156" y="300" text-anchor="end" font-family="${CARD_FONT}" font-size="92" font-weight="bold" fill="url(#gold)">${esc(ounceText)}</text>`;
  inner += `<rect x="796" y="336" width="360" height="52" rx="12" fill="${gold.trendColor}" fill-opacity="0.16" stroke="${gold.trendColor}" stroke-width="2"/>`;
  inner += arText(976, 372, 24, gold.trendColor, changeText, { anchor: 'middle', rtl: false });
  inner += `<rect x="456" y="336" width="316" height="52" rx="12" fill="#1E293B" stroke="#334155" stroke-width="2"/>`;
  inner += arText(614, 372, 23, '#E2E8F0', trendAr, { anchor: 'middle' });
  inner += goldBars(130, 195, 1.5);

  const cards = [
    { x: 804, label: 'عيار 24 / جرام', val: g24 },
    { x: 444, label: 'عيار 21 / جرام', val: g21 },
    { x: 84, label: 'عيار 18 / جرام', val: g18 }
  ];
  for (const c of cards) {
    inner += `<rect x="${c.x + 40}" y="455" width="312" height="162" rx="20" fill="#1E293B" stroke="#F59E0B" stroke-opacity="0.3" stroke-width="1.5"/>`;
    inner += arText(c.x + 40 + 156, 505, 24, '#94A3B8', c.label, { anchor: 'middle', weight: 'normal' });
    inner += arText(c.x + 40 + 156, 574, 48, '#FDE047', c.val, { anchor: 'middle', rtl: false });
  }
  return svgShell(gold, inner);
}

function buildPointsSvg(gold, insights) {
  let inner = arText(RIGHT, 205, 44, '#F59E0B', 'أبرز نقاط المقال');
  const points = insights.points.slice(0, 4);
  const top = 235;
  const step = 98;
  points.forEach((p, i) => {
    const y = top + i * step;
    inner += `<rect x="${LEFT}" y="${y}" width="${RIGHT - LEFT}" height="82" rx="16" fill="#1E293B" stroke="#F59E0B" stroke-opacity="0.25" stroke-width="1.5"/>`;
    inner += `<circle cx="${RIGHT - 44}" cy="${y + 41}" r="24" fill="url(#gold)"/>`;
    inner += `<text x="${RIGHT - 44}" y="${y + 51}" text-anchor="middle" font-family="${CARD_FONT}" font-size="28" font-weight="bold" fill="#0F172A">${i + 1}</text>`;
    const lines = wrapText(p, 62, 2);
    const size = lines.length > 1 ? 26 : 30;
    const base = lines.length > 1 ? y + 34 : y + 51;
    lines.forEach((line, li) => {
      inner += arText(RIGHT - 90, base + li * 34, size, '#F8FAFC', line, { weight: 'normal' });
    });
  });
  return svgShell(gold, inner);
}

function buildOutlookSvg(gold, insights) {
  let inner = arText(RIGHT, 215, 44, '#F59E0B', 'الخلاصة والتوقعات');
  inner += `<rect x="${LEFT}" y="250" width="${RIGHT - LEFT}" height="300" rx="24" fill="#1E293B" stroke="#F59E0B" stroke-opacity="0.35" stroke-width="2"/>`;
  inner += `<rect x="${RIGHT - 20}" y="278" width="8" height="244" rx="4" fill="url(#gold)"/>`;
  const lines = wrapText(insights.outlook, 44, 4);
  const startY = 250 + 150 - ((lines.length - 1) * 54) / 2 + 12;
  lines.forEach((line, i) => {
    inner += arText(RIGHT - 50, startY + i * 54, 40, '#F8FAFC', line, { weight: 'normal' });
  });
  inner += arText(RIGHT, 596, 20, '#64748B', 'للتوعية والمعلومات فقط، وليست توصية استثمارية', { weight: 'normal' });
  return svgShell(gold, inner);
}

async function svgToPng(svg) {
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function createArticleImages(gold, insights) {
  const svgs = [
    buildCoverSvg(gold, insights),
    buildPricesSvg(gold),
    buildPointsSvg(gold, insights),
    buildOutlookSvg(gold, insights)
  ];
  return Promise.all(svgs.map(svgToPng));
}

function isNonChatModel(modelId) {
  const lower = modelId.toLowerCase();
  return ['whisper', 'orpheus', 'tts', 'guard', 'safeguard', 'embed'].some((kw) => lower.includes(kw));
}

async function resolveGroqModelCandidates() {
  const candidates = [];
  try {
    const res = await fetchWithRetry('https://api.groq.com/openai/v1/models', {
      headers: {
        'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }, 1);

    if (res?.ok) {
      const data = await res.json();
      const allModels = (data.data || []).map((m) => m.id).filter((id) => !isNonChatModel(id));
      const availableSet = new Set(allModels);
      for (const modelId of CONFIG.PREFERRED_MODELS) {
        if (availableSet.has(modelId) && !candidates.includes(modelId)) candidates.push(modelId);
      }
      for (const id of allModels) {
        if (!candidates.includes(id)) candidates.push(id);
      }
    }
  } catch (err) {
    console.warn(`تعذر فحص قائمة نماذج Groq: ${err.message}`);
  }

  for (const fallback of ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']) {
    if (!candidates.includes(fallback)) candidates.push(fallback);
  }
  return candidates;
}

function sanitizeTelegramHtml(text) {
  let cleaned = text.trim()
    .replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>')
    .replace(/^#{1,4}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p\s*>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/?(ul|ol)[^>]*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<\/li\s*>/gi, '\n');

  const allowedTags = new Set(['b', 'strong', 'i', 'em', 'u', 'ins', 's', 'strike', 'del', 'code', 'pre', 'blockquote']);
  cleaned = cleaned.replace(/<\/?([a-zA-Z0-9]+)([^>]*)>/g, (match, tagName) => {
    const lowerTag = tagName.toLowerCase();
    if (allowedTags.has(lowerTag)) {
      return match.startsWith('</') ? `</${lowerTag}>` : `<${lowerTag}>`;
    }
    return '';
  });

  cleaned = cleaned.replace(/&(?!(amp|lt|gt|quot);)/g, '&');
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

function stripHtmlTags(htmlText) {
  return htmlText
    .replace(/<[^>]+>/g, '')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"');
}

// ───────────────────────── Groq ─────────────────────────

function cleanModelOutput(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

async function callGroq(messages, { temperature = 0.5, maxTokens = 3200 } = {}) {
  const candidates = await resolveGroqModelCandidates();
  let lastError = null;

  for (const model of candidates) {
    try {
      const res = await fetchWithRetry('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens })
      });

      if (!res?.ok) {
        lastError = new Error(res ? await res.text() : 'انقطع الاتصال بخادم Groq');
        continue;
      }

      const data = await res.json();
      const content = cleanModelOutput(data.choices?.[0]?.message?.content);
      if (content) return content;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('فشل الاتصال بجميع النماذج المتاحة في Groq');
}

function buildMarketBrief(gold) {
  return gold.available
    ? [
        `اتجاه السوق: ${gold.trend} (${gold.trendEmoji})`,
        `سعر الأونصة عالمياً: ${gold.ounceUsd} دولار`,
        `التغير اليومي: ${gold.changeUsd} دولار (${gold.changePercent})`,
        `عيار 24: ${gold.gram24Usd} دولار | عيار 21: ${gold.gram21Usd} دولار | عيار 18: ${gold.gram18Usd} دولار`,
        `الجلسة التداولية: ${gold.session}`
      ].join('\n')
    : `تعذر سحب التسعير اللحظي وقت النشر. الجلسة التداولية: ${gold.session}`;
}

async function generateEditorialArticle(gold) {
  const systemPrompt = [
    'أنت خبير اقتصادي بخبرة تزيد عن 20 عامًا في الاقتصاد الكلي والجزئي والأسواق المالية، وكاتب مقالات محترف تكتب لصحف ومجلات اقتصادية كبرى.',
    'اكتب مقالاً اقتصادياً تحليلياً معمقاً وشاملاً حول حركة أسعار الذهب وتأثيرها على السوق المحلي والعربي، للنشر في قناة تليجرام (حوالي 900 إلى 1100 كلمة).',
    'ابدأ المقال بعنوان جذاب داخل <b></b> في السطر الأول.',
    'استخدم <b> و <i> فقط للتنسيق، واستخدم "•" للقوائم بدون استخدام ** أو ## أو شرطات -.'
  ].join('\n');

  const raw = await callGroq(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `اكتب المقال بناءً على هذه المعطيات فقط:\n\n${buildMarketBrief(gold)}` }
    ],
    { temperature: 0.5, maxTokens: 3200 }
  );
  return sanitizeTelegramHtml(raw);
}

function defaultInsights(gold) {
  return {
    headline: gold.available
      ? `الذهب ${gold.trend === 'استقرار نسبي' ? 'يستقر' : gold.trend === 'صعود' ? 'يصعد' : 'يهبط'} عند ${gold.ounceUsd} دولار للأونصة`
      : 'قراءة في حركة أسعار الذهب اليوم',
    points: [
      'متابعة حركة الأونصة عالمياً هي المؤشر الأول لسعر الذهب محلياً',
      'سعر الدولار وقرارات الفائدة من أهم المحركات اليومية للمعدن',
      'الطلب على الملاذ الآمن يرتفع مع زيادة التوترات الاقتصادية',
      'الفروق بين الأعيرة تعتمد على نسبة نقاء الذهب في كل عيار'
    ],
    outlook: 'يبقى الذهب أداة تحوط رئيسية، والقرارات الاستثمارية تحتاج متابعة مستمرة لتحركات الدولار والفائدة.'
  };
}

function parseInsights(text) {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  const obj = JSON.parse(match[0]);
  const headline = String(obj.headline || '').trim();
  const outlook = String(obj.outlook || '').trim();
  const points = Array.isArray(obj.points)
    ? obj.points.map((p) => String(p).trim()).filter(Boolean)
    : [];
  if (!headline || !outlook || points.length < 3) return null;
  return { headline, outlook, points: points.slice(0, 4) };
}

async function generateInsights(gold, articleHtml) {
  try {
    const articleText = stripHtmlTags(articleHtml).slice(0, 6000);
    const raw = await callGroq(
      [
        {
          role: 'system',
          content: [
            'أنت محرر يلخص مقالات اقتصادية لبطاقات إنفوجرافيك.',
            'أعد JSON صالحاً فقط بدون أي نص آخر وبدون علامات ```، بهذا الشكل بالضبط:',
            '{"headline":"عنوان قوي لا يتجاوز 60 حرفاً","points":["نقطة 1","نقطة 2","نقطة 3","نقطة 4"],"outlook":"خلاصة وتوقع في جملة أو جملتين لا تتجاوز 150 حرفاً"}',
            'كل نقطة لا تتجاوز 90 حرفاً، وبدون أي وسوم HTML أو رموز تنسيق، واعتمد على المقال فقط.'
          ].join('\n')
        },
        { role: 'user', content: `المقال:\n\n${articleText}` }
      ],
      { temperature: 0.3, maxTokens: 800 }
    );
    return parseInsights(raw) || defaultInsights(gold);
  } catch (err) {
    console.warn(`تعذر توليد ملخص الصور، سيتم استخدام ملخص افتراضي (${err.message})`);
    return defaultInsights(gold);
  }
}

// ───────────────────────── تليجرام ─────────────────────────

async function sendAlbumToTelegram(pngBuffers, gold) {
  const caption = gold.available
    ? `<b>تقرير الذهب اليومي ${gold.trendEmoji}</b>\n• الأونصة: <b>${gold.ounceUsd}$</b> (${gold.changePercent})\n• عيار 24: <b>${gold.gram24Usd}$</b> | عيار 21: <b>${gold.gram21Usd}$</b>`
    : '<b>تقرير الذهب اليومي 🥇</b>';

  const formData = new FormData();
  formData.append('chat_id', CONFIG.TELEGRAM_CHAT_ID);

  const media = pngBuffers.map((_, i) => {
    const item = { type: 'photo', media: `attach://img${i}` };
    if (i === 0) {
      item.caption = caption;
      item.parse_mode = 'HTML';
    }
    return item;
  });
  formData.append('media', JSON.stringify(media));
  pngBuffers.forEach((buf, i) => {
    formData.append(`img${i}`, new Blob([buf], { type: 'image/png' }), `gold-${i + 1}.png`);
  });

  const res = await fetchWithRetry(
    `[https://api.telegram.org/bot$](https://api.telegram.org/bot$){CONFIG.TELEGRAM_BOT_TOKEN}/sendMediaGroup`,
    { method: 'POST', body: formData },
    2,
    45000
  );

  if (!res?.ok) {
    const errText = res ? await res.text() : 'انقطع الاتصال بخادم تليجرام';
    throw new Error(`فشل إرسال الصور إلى تليجرام: ${errText}`);
  }
}

async function sendToTelegram(htmlText) {
  const url = `[https://api.telegram.org/bot$](https://api.telegram.org/bot$){CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const MAX_LENGTH = 4000;
  const chunks = [];

  if (htmlText.length <= MAX_LENGTH) {
    chunks.push(htmlText);
  } else {
    let remaining = htmlText;
    while (remaining.length > 0) {
      if (remaining.length <= MAX_LENGTH) {
        chunks.push(remaining);
        break;
      }
      let splitIndex = remaining.lastIndexOf('\n\n', MAX_LENGTH);
      if (splitIndex === -1) splitIndex = remaining.lastIndexOf('\n', MAX_LENGTH);
      if (splitIndex === -1) splitIndex = MAX_LENGTH;
      chunks.push(remaining.slice(0, splitIndex).trim());
      remaining = remaining.slice(splitIndex).trim();
    }
  }

  for (const chunk of chunks) {
    const res = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CONFIG.TELEGRAM_CHAT_ID,
        text: chunk,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      })
    });

    if (res?.ok) continue;

    const errText = res ? await res.text() : 'انقطع الاتصال بخادم تليجرام';
    if (res?.status === 400 && errText.includes("can't parse entities")) {
      const plainRes = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: CONFIG.TELEGRAM_CHAT_ID,
          text: stripHtmlTags(chunk),
          disable_web_page_preview: true
        })
      });
      if (plainRes?.ok) continue;
    }
    throw new Error(`فشل الإرسال لتليجرام: ${errText}`);
  }
}

// ───────────────────────── إبلاغ موقع سهم الذهب ─────────────────────────

async function reportArticleToSite(gold, insights, articleHtml) {
  const url = (CONFIG.SITE_API_URL || '').trim();
  const secret = (CONFIG.SITE_API_SECRET || '').trim();
  if (!url || !secret) return;

  try {
    const payload = {
      date: gold?.date || new Date().toISOString(),
      ounceUsd: gold?.available ? Number(gold.ounceUsd) : null,
      headline: insights?.headline || 'تقرير أسعار الذهب اليومي',
      articleHtml
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${secret}`
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT_MS)
    });

    if (!res.ok) {
      console.warn(`⚠️ تحذير: فشل إرسال التقرير إلى الموقع (HTTP ${res.status}) دون التأثير على نشر تليجرام.`);
    } else {
      console.log('✅ تم إرسال التقرير إلى موقع سهم الذهب بنجاح.');
    }
  } catch (err) {
    console.warn(`⚠️ تحذير: تعذر الوصول لموقع سهم الذهب (${err.message}) دون التأثير على نشر تليجرام.`);
  }
}

// ───────────────────────── التشغيل ─────────────────────────

async function main() {
  validateEnvironment();
  const gold = await fetchGoldData();

  const article = await generateEditorialArticle(gold);
  const insights = await generateInsights(gold, article);
  const images = await createArticleImages(gold, insights);

  await sendAlbumToTelegram(images, gold);
  await sendToTelegram(article);
  console.log('تم نشر الصور والمقال بنجاح!');

  await reportArticleToSite(gold, insights, article);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ توقف التنفيذ بسبب خطأ:', err.message);
    process.exit(1);
  });
}

module.exports = {
  buildCoverSvg,
  buildPricesSvg,
  buildPointsSvg,
  buildOutlookSvg,
  calculateGoldMetrics,
  defaultInsights,
  parseInsights,
  wrapText
};
