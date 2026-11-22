const zlib = require('zlib');

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

function calculateGoldMetrics(ounceUsd, changeUsd, changePercent, rawDate, sourceName) {
  const ounce = Number(ounceUsd);
  const chg = Number(changeUsd || 0);
  const pct = Number(changePercent || 0);

  const gram24 = ounce / CONFIG.TROY_OUNCE_TO_GRAMS;
  const gram21 = gram24 * (21 / 24);
  const gram18 = gram24 * (18 / 24);

  let trend = 'استقرار نسبي';
  let trendEmoji = '⚖️';
  if (pct > 0.15) {
    trend = 'صعود';
    trendEmoji = '📈';
  } else if (pct < -0.15) {
    trend = 'هبوط';
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
    trendEmoji,
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
    session: getMarketSessionContext(),
    date: new Date().toISOString()
  };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function createGoldBannerPng(gold) {
  const width = 640;
  const height = 320;
  let accent = [245, 158, 11];
  if (gold.available && gold.pctNumber > 0.15) accent = [34, 197, 94];
  else if (gold.available && gold.pctNumber < -0.15) accent = [239, 68, 68];

  const rawScanlines = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 3);
    rawScanlines[rowStart] = 0;
    const ny = y / height;
    for (let x = 0; x < width; x++) {
      const nx = x / width;
      const px = rowStart + 1 + x * 3;
      const glow = Math.max(0, 1 - Math.hypot(nx - 0.5, ny - 0.5) * 1.35);
      let r = Math.round(14 + nx * 18 + glow * 45);
      let g = Math.round(20 + ny * 16 + glow * 32);
      let b = Math.round(34 + (1 - nx) * 20 + glow * 10);

      if (x < 10 || x >= width - 10 || y < 10 || y >= height - 10) {
        r = 217; g = 155; b = 38;
      } else if ((y >= 24 && y <= 36) || (y >= height - 36 && y <= height - 24)) {
        r = 245; g = 185; b = 45;
      } else if (y >= 135 && y <= 185 && x >= 80 && x <= width - 80) {
        const barFill = gold.available ? Math.min(1, Math.max(0.18, 0.5 + gold.pctNumber * 0.25)) : 0.5;
        const progressX = 80 + (width - 160) * barFill;
        if (x <= progressX) {
          r = accent[0]; g = accent[1]; b = accent[2];
        } else {
          r = 35; g = 45; b = 65;
        }
      }

      rawScanlines[px] = Math.min(255, Math.max(0, r));
      rawScanlines[px + 1] = Math.min(255, Math.max(0, g));
      rawScanlines[px + 2] = Math.min(255, Math.max(0, b));
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;

  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', zlib.deflateSync(rawScanlines, { level: 6 })),
    makePngChunk('IEND', Buffer.alloc(0))
  ]);
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
    console.warn('تعذر فحص قائمة نماذج Groq:', err.message);
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
  const systemPrompt = `أنت خبير اقتصادي بخبرة تزيد عن 20 عامًا في الاقتصاد الكلي والجزئي والأسواق المالية، وكاتب مقالات محترف تكتب لصحف ومجلات اقتصادية كبرى.
اكتب مقالاً اقتصادياً تحليلياً معمقاً وشاملاً حول حركة أسعار الذهب وتأثيرها على السوق المحلي والعربي، للنشر في قناة تليجرام (حوالي 900 إلى 1100 كلمة).
استخدم <b> و <i> فقط للتنسيق، واستخدم "•" للقوائم بدون استخدام ** أو ## أو شرطات -.`;

  const marketBrief = gold.available
    ? `اتجاه السوق: ${gold.trend} (${gold.trendEmoji})
سعر الأونصة عالمياً: ${gold.ounceUsd} دولار
التغير اليومي: ${gold.changeUsd} دولار (${gold.changePercent})
عيار 24: ${gold.gram24Usd} دولار | عيار 21: ${gold.gram21Usd} دولار | عيار 18: ${gold.gram18Usd} دولار
الجلسة التداولية: ${gold.session}`
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
    : `<b>تقرير الذهب اليومي 🥇</b>`;

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
  console.log('✅ تم إرسال الصورة إلى تليجرام بنجاح!');
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
  const pngBuffer = createGoldBannerPng(gold);
  await sendPhotoToTelegram(pngBuffer, gold);
  const article = await generateEditorialArticle(gold);
  await sendToTelegram(article);
  console.log('✅ تم نشر الصورة والمقال بنجاح!');
}

main().catch((err) => {
  console.error('❌ توقف التنفيذ بسبب خطأ:', err.message);
  process.exit(1);
});
