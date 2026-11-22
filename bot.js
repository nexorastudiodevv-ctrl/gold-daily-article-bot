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

function formatArabicDate(rawDate) {
  const d = new Date(rawDate || Date.now());
  if (Number.isNaN(d.getTime())) return 'تحديث اليوم';
  return d.toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
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
  let trendColor = '#EAB308';
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
    trend,
    trendEn,
    trendColor,
    trendEmoji,
    session: getMarketSessionContext(),
    readableDate: formatArabicDate(rawDate),
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
    trendEn: 'MARKET REPORT',
    trendColor: '#EAB308',
    session: getMarketSessionContext(),
    readableDate: formatArabicDate(new Date().toISOString()),
    date: new Date().toISOString()
  };
}

async function createGoldCardPng(gold) {
  const ounceText = gold.available ? `$${gold.ounceUsd}` : 'LIVE MARKET';
  const changeText = gold.available ? `${gold.changeUsd}$  (${gold.changePercent})` : 'DAILY ANALYSIS';
  const g24 = gold.available ? `$${gold.gram24Usd}` : '--';
  const g21 = gold.available ? `$${gold.gram21Usd}` : '--';
  const g18 = gold.available ? `$${gold.gram18Usd}` : '--';

  // استخدام الأرقام والرموز الإنجليزية في SVG لضمان عدم تقطع الحروف على خوادم Linux
  const svg = `
  <svg width="1280" height="720" viewBox="0 0 1280 720" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#0B0F19"/>
        <stop offset="55%" stop-color="#131B2E"/>
        <stop offset="100%" stop-color="#1E293B"/>
      </linearGradient>
      <linearGradient id="goldGrad" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#FDE047"/>
        <stop offset="50%" stop-color="#F59E0B"/>
        <stop offset="100%" stop-color="#D97706"/>
      </linearGradient>
    </defs>

    <rect width="1280" height="720" fill="url(#bgGrad)"/>
    <circle cx="1120" cy="140" r="240" fill="#F59E0B" fill-opacity="0.06"/>
    <circle cx="160" cy="620" r="200" fill="#F59E0B" fill-opacity="0.05"/>

    <rect x="48" y="48" width="1184" height="624" rx="28" fill="#0F172A" fill-opacity="0.7" stroke="#F59E0B" stroke-opacity="0.35" stroke-width="2"/>

    <!-- الشريط العلوي -->
    <rect x="90" y="92" width="12" height="44" rx="6" fill="url(#goldGrad)"/>
    <text x="118" y="123" font-family="DejaVu Sans, Arial, sans-serif" font-size="30" font-weight="bold" fill="#F8FAFC">SAHM ELZAHAB  |  GOLD MARKET REPORT</text>
    <text x="1190" y="122" text-anchor="end" font-family="DejaVu Sans, Arial, sans-serif" font-size="24" fill="#94A3B8">${gold.readableDate}</text>

    <!-- السعر الرئيسي للأونصة -->
    <text x="90" y="215" font-family="DejaVu Sans, Arial, sans-serif" font-size="24" font-weight="bold" fill="#F59E0B" letter-spacing="2">XAU / USD SPOT OUNCE</text>
    <text x="90" y="325" font-family="DejaVu Sans, Arial, sans-serif" font-size="108" font-weight="bold" fill="url(#goldGrad)">${ounceText}</text>

    <!-- شارة التغير -->
    <rect x="90" y="362" width="380" height="54" rx="14" fill="${gold.trendColor}" fill-opacity="0.16" stroke="${gold.trendColor}" stroke-width="2"/>
    <text x="280" y="397" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="25" font-weight="bold" fill="${gold.trendColor}">${changeText}</text>

    <rect x="495" y="362" width="320" height="54" rx="14" fill="#1E293B" stroke="#334155" stroke-width="2"/>
    <text x="655" y="397" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="22" font-weight="bold" fill="#E2E8F0">${gold.trendEn}</text>

    <!-- بطاقات الأعيرة -->
    <rect x="90" y="465" width="345" height="155" rx="20" fill="#1E293B" fill-opacity="0.85" stroke="#F59E0B" stroke-opacity="0.3" stroke-width="1.5"/>
    <text x="262" y="512" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="22" fill="#94A3B8">24K GOLD / GRAM</text>
    <text x="262" y="578" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="46" font-weight="bold" fill="#FDE047">${g24}</text>

    <rect x="467" y="465" width="345" height="155" rx="20" fill="#1E293B" fill-opacity="0.85" stroke="#F59E0B" stroke-opacity="0.3" stroke-width="1.5"/>
    <text x="639" y="512" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="22" fill="#94A3B8">21K GOLD / GRAM</text>
    <text x="639" y="578" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="46" font-weight="bold" fill="#FDE047">${g21}</text>

    <rect x="845" y="465" width="345" height="155" rx="20" fill="#1E293B" fill-opacity="0.85" stroke="#F59E0B" stroke-opacity="0.3" stroke-width="1.5"/>
    <text x="1017" y="512" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="22" fill="#94A3B8">18K GOLD / GRAM</text>
    <text x="1017" y="578" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="46" font-weight="bold" fill="#FDE047">${g18}</text>

    <!-- شارة سبائك -->
    <rect x="920" y="190" width="270" height="225" rx="24" fill="#1E293B" stroke="#F59E0B" stroke-opacity="0.45" stroke-width="2"/>
    <polygon points="1055,230 1135,280 1055,330 975,280" fill="url(#goldGrad)"/>
    <polygon points="975,280 1055,330 1055,375 975,325" fill="#B45309"/>
    <polygon points="1135,280 1055,330 1055,375 1135,325" fill="#D97706"/>
    <text x="1055" y="402" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-size="18" font-weight="bold" fill="#FDE047">@sahm_elzahab</text>
  </svg>`;

  return await sharp(Buffer.from(svg)).png().toBuffer();
}

function isNonChatModel(modelId) {
  const lower = modelId.toLowerCase();
  return ['whisper', 'orpheus', 'tts', 'guard', 'safeguard', 'embed'].some((kw) =>
    lower.includes(kw)
  );
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
  let cleaned = text.trim();

  cleaned = cleaned
    .replace(/\*\*(.+?)\*\*/gs, '<b>$1</b>')
    .replace(/^#{1,4}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/^\s*[-*]\s+/gm, '• ');

  cleaned = cleaned
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

مهمتك: كتابة مقال اقتصادي تحليلي معمق وشامل حول حركة أسعار الذهب وتأثيرها على السوق المحلي والعربي، للنشر في قناة "سهم الذهب" على تليجرام.

المعايير التحريرية:
- الجمهور المستهدف: القارئ العادي المهتم بالادخار والذهب، وصغار المستثمرين.
- السوق محل التركيز: السوق العالمي وانعكاسه المباشر على مصر والمنطقة العربية.
- النبرة واللغة: تحليلية مبسطة، باللغة العربية الفصحى المعاصرة السلسة.
- الطول المطلوب: مقال موسع ومتماسك يقارب 1000 كلمة (في حدود 900 إلى 1100 كلمة) مقسم إلى فقرات قصيرة وعناوين فرعية واضحة ومريحة للقراءة على الهاتف.

قواعد الكتابة الصارمة:
1. ابدأ بعنوان خبري جذاب ومقدمة قوية ومشوقة تشد القارئ من أول سطرين.
2. قسّم المقال إلى عناوين فرعية واضحة تغطي: المشهد السعري والبيانات، العوامل الاقتصادية الكلية، انعكاس السوق العالمي على الأسواق المحلية، توازن وجهات النظر في السوق، وخلاصة وتوصية عملية.
3. بسّط المصطلحات الاقتصادية المعقدة (مثل التضخم، أسعار الفائدة، عوائد السندات، والسيولة) بأمثلة واضحة من الواقع اليومي وحياة الناس.
4. الالتزام التام بالأرقام المرفقة فقط؛ لا تخترع أي إحصائيات أو أسعار صرف أو أرقام غير موجودة في البيانات، واذكر بوضوح أن التسعير المحلي يتأثر بعوامل العرض والطلب المحلي وسعر الصرف والمصنعية.
5. اعرض أكثر من وجهة نظر قبل الوصول لرأيك أو تحليلك (رؤية من يراهنون على التحوط والشراء مقابل رؤية من يفضلون التريث أو جني الأرباح المرحلي).
6. اربط الأسباب بالنتائج بوضوح، واختم بخلاصة وتوصية عملية متزنة مع تنويه قصير في النهاية بأن الأسعار استرشادية وتتغير لحظياً.
7. التنسيق: استخدم وسوم HTML البسيطة فقط للتأكيد: <b>للنص العريض</b> و <i>للنص المائل</i>، واستخدم علامة • للنقاط بدلاً من الشرطة. يُمنع استخدام علامات Markdown مثل ** أو ## أو الجداول.`;

  const marketBrief = gold.available
    ? `البيانات اللحظية المعتمدة للمقال:
• اتجاه السوق: ${gold.trend} (${gold.trendEmoji})
• سعر الأونصة عالمياً: ${gold.ounceUsd} دولار
• مقدار التغير اليومي: ${gold.changeUsd} دولار (${gold.changePercent})
• السعر العالمي المرجعي للجرام: عيار 24 (${gold.gram24Usd} دولار) | عيار 21 (${gold.gram21Usd} دولار) | عيار 18 (${gold.gram18Usd} دولار)
• توقيت الجلسة التداولية: ${gold.session}
• تاريخ التحديث: ${gold.readableDate}`
    : `البيانات اللحظية المعتمدة للمقال:
• حالة المصدر: تعذر سحب التسعير اللحظي وقت النشر (${gold.readableDate}).
• توقيت الجلسة التداولية: ${gold.session}
• توجيه خاص: ركّز في المقال على تحليل المحركات الاقتصادية لأسعار الذهب وسلوك المدخرين دون ذكر أي أرقام سعرية محددة.`;

  const userPrompt = `اكتب المقال الاقتصادي الكامل الآن (حوالي 1000 كلمة) بناءً على هذه المعطيات فقط:\n\n${marketBrief}`;

  const candidates = await resolveGroqModelCandidates();
  let lastError = null;

  for (const model of candidates) {
    console.log(`محاولة التوليد عبر النموذج: ${model}`);
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
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.5,
          max_tokens: 3200
        })
      });

      if (!res?.ok) {
        const errText = res ? await res.text() : 'انقطع الاتصال بخادم Groq';
        lastError = new Error(`فشل توليد المقال من Groq (${model}): ${errText}`);
        console.warn(lastError.message);
        continue;
      }

      const data = await res.json();
      const rawArticle = data.choices?.[0]?.message?.content;
      if (!rawArticle) {
        lastError = new Error(`استجابة Groq فارغة من النموذج (${model})`);
        continue;
      }

      console.log(`تم التوليد بنجاح عبر النموذج: ${model}`);
      return sanitizeTelegramHtml(rawArticle);
    } catch (err) {
      lastError = err;
      console.warn(`خطأ أثناء المحاولة مع النموذج (${model}): ${err.message}`);
    }
  }

  throw lastError || new Error('فشل توليد المقال من جميع النماذج المتاحة في Groq');
}

async function sendPhotoToTelegram(imageBuffer, gold) {
  const caption = gold.available
    ? `<b>نشرة سهم الذهب اليومية ${gold.trendEmoji}</b>\n\n• الأونصة عالمياً: <b>${gold.ounceUsd} دولار</b> (${gold.changePercent})\n• عيار 24: <b>${gold.gram24Usd}$</b> | عيار 21: <b>${gold.gram21Usd}$</b> | عيار 18: <b>${gold.gram18Usd}$</b>\n\n👇 المقال التحليلي الشامل في الرسالة التالية`
    : `<b>نشرة سهم الذهب اليومية 🥇</b>\n\n👇 المقال التحليلي الشامل لحركة الأسواق في الرسالة التالية`;

  const formData = new FormData();
  formData.append('chat_id', CONFIG.TELEGRAM_CHAT_ID);
  formData.append('caption', caption);
  formData.append('parse_mode', 'HTML');
  formData.append('photo', new Blob([imageBuffer], { type: 'image/png' }), 'sahm-elzahab-report.png');

  const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendPhoto`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    body: formData
  });

  if (!res?.ok) {
    const errText = res ? await res.text() : 'انقطع الاتصال بخادم تليجرام';
    throw new Error(`فشل إرسال الصورة إلى تليجرام: ${errText}`);
  }
}

async function sendArticleToTelegram(htmlText) {
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

    throw new Error(`فشل إرسال المقال لتليجرام: ${errText}`);
  }
}

async function main() {
  validateEnvironment();

  console.log('1/4 جاري سحب وحساب مؤشرات الذهب العالمية...');
  const gold = await fetchGoldData();
  console.log('ملخص المؤشرات:', gold);

  console.log('2/4 جاري تصميم بطاقة الأسعار البصرية...');
  const cardBuffer = await createGoldCardPng(gold);

  console.log('3/4 جاري صياغة المقال الاقتصادي عبر Groq...');
  const article = await generateEditorialArticle(gold);

  console.log('4/4 جاري نشر الصورة والمقال في قناة تليجرام...');
  await sendPhotoToTelegram(cardBuffer, gold);
  await sendArticleToTelegram(article);
  console.log('تم نشر البطاقة البصرية والمقال الصحفي بنجاح!');
}

main().catch((err) => {
  console.error('❌ توقف التنفيذ بسبب خطأ:', err.message);
  process.exit(1);
});
