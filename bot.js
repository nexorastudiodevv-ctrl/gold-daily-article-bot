const sharp = require('sharp');

const CONFIG = {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
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

async function createGoldCardPng(gold) {
  const ounceText = gold.available ? `$${gold.ounceUsd}` : 'سعر الذهب';
  const changeText = gold.available ? `${gold.changeUsd}$ (${gold.changePercent})` : 'تقرير يومي';
  const g24 = gold.available ? `$${gold.gram24Usd}` : '--';
  const g21 = gold.available ? `$${gold.gram21Usd}` : '--';
  const g18 = gold.available ? `$${gold.gram18Usd}` : '--';

  let trendAr = 'استقرار نسبي';
  if (gold.available && gold.pctNumber > 0.15) {
    trendAr = 'صعود السوق';
  } else if (gold.available && gold.pctNumber < -0.15) {
    trendAr = 'هبوط السوق';
  }

  const svg = [
    `<svg width="1280" height="720" viewBox="0 0 1280 720" xmlns="http://www.w3.org/2000/svg">`,
    `<defs>`,
    `<linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">`,
    `<stop offset="0%" stop-color="#090D16"/>`,
    `<stop offset="55%" stop-color="#111827"/>`,
    `<stop offset="100%" stop-color="#1E293B"/>`,
    `</linearGradient>`,
    `<linearGradient id="gold" x1="0%" y1="0%" x2="100%" y2="0%">`,
    `<stop offset="0%" stop-color="#FEF08A"/>`,
    `<stop offset="50%" stop-color="#F59E0B"/>`,
    `<stop offset="100%" stop-color="#D97706"/>`,
    `</linearGradient>`,
    `</defs>`,
    `<rect width="1280" height="720" fill="url(#bg)"/>`,
    `<rect x="40" y="40" width="1200" height="640" rx="28" fill="#0F172A" fill-opacity="0.82" stroke="#F59E0B" stroke-opacity="0.4" stroke-width="2"/>`,
    `<rect x="1174" y="84" width="10" height="40" rx="5" fill="url(#gold)"/>`,
    `<text x="1156" y="113" text-anchor="end" direction="rtl" font-family="${CARD_FONT}" font-size="25" font-weight="bold" fill="#F8FAFC">سهم الذهب | أسعار الذهب</text>`,
    `<text x="84" y="113" text-anchor="start" font-family="${CARD_FONT}" font-size="22" font-weight="bold" fill="#94A3B8">${gold.dateLabel}</text>`,
    `<text x="1176" y="192" text-anchor="end" direction="rtl" font-family="${CARD_FONT}" font-size="22" font-weight="bold" fill="#F59E0B">سعر الأونصة عالمياً (دولار)</text>`,
    `<text x="1176" y="298" text-anchor="end" font-family="${CARD_FONT}" font-size="92" font-weight="bold" fill="url(#gold)">${ounceText}</text>`,
    `<rect x="816" y="336" width="360" height="52" rx="12" fill="${gold.trendColor}" fill-opacity="0.16" stroke="${gold.trendColor}" stroke-width="2"/>`,
    `<text x="996" y="370" text-anchor="middle" font-family="${CARD_FONT}" font-size="23" font-weight="bold" fill="${gold.trendColor}">${changeText}</text>`,
    `<rect x="476" y="336" width="316" height="52" rx="12" fill="#1E293B" stroke="#334155" stroke-width="2"/>`,
    `<text x="634" y="370" text-anchor="middle" direction="rtl" font-family="${CARD_FONT}" font-size="21" font-weight="bold" fill="#E2E8F0">${trendAr}</text>`,
    `<rect x="84" y="168" width="306" height="220" rx="22" fill="#1E293B" stroke="#F59E0B" stroke-opacity="0.4" stroke-width="2"/>`,
    `<polygon points="237,203 316,252 237,301 158,252" fill="url(#gold)"/>`,
    `<polygon points="158,252 237,301 237,343 158,294" fill="#B45309"/>`,
    `<polygon points="316,252 237,301 237,343 316,294" fill="#D97706"/>`,
    `<text x="237" y="371" text-anchor="middle" font-family="${CARD_FONT}" font-size="18" font-weight="bold" fill="#FDE047">@sahm_elzahab</text>`,
    `<rect x="844" y="455" width="352" height="162" rx="20" fill="#1E293B" stroke="#F59E0B" stroke-opacity="0.3" stroke-width="1.5"/>`,
    `<text x="1020" y="502" text-anchor="middle" direction="rtl" font-family="${CARD_FONT}" font-size="22" fill="#94A3B8">عيار 24 / جرام</text>`,
    `<text x="1020" y="572" text-anchor="middle" font-family="${CARD_FONT}" font-size="44" font-weight="bold" fill="#FDE047">${g24}</text>`,
    `<rect x="464" y="455" width="352" height="162" rx="20" fill="#1E293B" stroke="#F59E0B" stroke-opacity="0.3" stroke-width="1.5"/>`,
    `<text x="640" y="502" text-anchor="middle" direction="rtl" font-family="${CARD_FONT}" font-size="22" fill="#94A3B8">عيار 21 / جرام</text>`,
    `<text x="640" y="572" text-anchor="middle" font-family="${CARD_FONT}" font-size="44" font-weight="bold" fill="#FDE047">${g21}</text>`,
    `<rect x="84" y="455" width="352" height="162" rx="20" fill="#1E293B" stroke="#F59E0B" stroke-opacity="0.3" stroke-width="1.5"/>`,
    `<text x="260" y="502" text-anchor="middle" direction="rtl" font-family="${CARD_FONT}" font-size="22" fill="#94A3B8">عيار 18 / جرام</text>`,
    `<text x="260" y="572" text-anchor="middle" font-family="${CARD_FONT}" font-size="44" font-weight="bold" fill="#FDE047">${g18}</text>`,
    `</svg>`
  ].join('\n');

  return await sharp(Buffer.from(svg)).png().toBuffer();
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

  cleaned = cleaned.replace(/&(?!(amp|lt|gt|quot);)/g, '&amp;');
  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

function stripHtmlTags(htmlText) {
  return htmlText
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}

async function generateEditorialArticle(gold) {
  const systemPrompt = [
    'أنت خبير اقتصادي بخبرة تزيد عن 20 عامًا في الاقتصاد الكلي والجزئي والأسواق المالية، وكاتب مقالات محترف تكتب لصحف ومجلات اقتصادية كبرى.',
    'اكتب مقالاً اقتصادياً تحليلياً معمقاً وشاملاً حول حركة أسعار الذهب وتأثيرها على السوق المحلي والعربي، للنشر في قناة تليجرام (حوالي 900 إلى 1100 كلمة).',
    'استخدم <b> و <i> فقط للتنسيق، واستخدم "•" للقوائم بدون استخدام ** أو ## أو شرطات -.'
  ].join('\n');

  const marketBrief = gold.available
    ? [
        `اتجاه السوق: ${gold.trend} (${gold.trendEmoji})`,
        `سعر الأونصة عالمياً: ${gold.ounceUsd} دولار`,
        `التغير اليومي: ${gold.changeUsd} دولار (${gold.changePercent})`,
        `عيار 24: ${gold.gram24Usd} دولار | عيار 21: ${gold.gram21Usd} دولار | عيار 18: ${gold.gram18Usd} دولار`,
        `الجلسة التداولية: ${gold.session}`
      ].join('\n')
    : `تعذر سحب التسعير اللحظي وقت النشر. الجلسة التداولية: ${gold.session}`;

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
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `اكتب المقال بناءً على هذه المعطيات فقط:\n\n${marketBrief}` }
          ],
          temperature: 0.5,
          max_tokens: 3200
        })
      });

      if (!res?.ok) {
        lastError = new Error(res ? await res.text() : 'انقطع الاتصال بخادم Groq');
        continue;
      }

      const data = await res.json();
      const rawArticle = data.choices?.[0]?.message?.content;
      if (rawArticle) return sanitizeTelegramHtml(rawArticle);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError || new Error('فشل توليد المقال من جميع النماذج المتاحة في Groq');
}

async function sendPhotoToTelegram(pngBuffer, gold) {
  const caption = gold.available
    ? `<b>تقرير الذهب اليومي ${gold.trendEmoji}</b>\n• الأونصة: <b>${gold.ounceUsd}$</b> (${gold.changePercent})\n• عيار 24: <b>${gold.gram24Usd}$</b> | عيار 21: <b>${gold.gram21Usd}$</b>`
    : '<b>تقرير الذهب اليومي 🥇</b>';

  const formData = new FormData();
  formData.append('chat_id', CONFIG.TELEGRAM_CHAT_ID);
  formData.append('caption', caption);
  formData.append('parse_mode', 'HTML');
  formData.append('photo', new Blob([pngBuffer], { type: 'image/png' }), 'gold-report.png');

  const res = await fetchWithRetry(
    `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendPhoto`,
    { method: 'POST', body: formData }
  );

  if (!res?.ok) {
    const errText = res ? await res.text() : 'انقطع الاتصال بخادم تليجرام';
    throw new Error(`فشل إرسال الصورة إلى تليجرام: ${errText}`);
  }
}

async function sendToTelegram(htmlText) {
  const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`;
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

async function main() {
  validateEnvironment();
  const gold = await fetchGoldData();
  const pngBuffer = await createGoldCardPng(gold);
  await sendPhotoToTelegram(pngBuffer, gold);
  const article = await generateEditorialArticle(gold);
  await sendToTelegram(article);
  console.log('تم نشر البطاقة البصرية والمقال بنجاح!');
}

main().catch((err) => {
  console.error('❌ توقف التنفيذ بسبب خطأ:', err.message);
  process.exit(1);
});
