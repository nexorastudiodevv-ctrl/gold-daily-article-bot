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

async function fetchWithRetry(url, options = {}, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT_MS)
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
  if (hour >= 0 && hour < 7) {
    return 'الجلسة الآسيوية (تداولات طوكيو وشنغهاي)';
  }
  if (hour >= 7 && hour < 13) {
    return 'الجلسة الأوروبية (بورصة لندن للمعادن الثمينة)';
  }
  if (hour >= 13 && hour < 21) {
    return 'الجلسة الأمريكية (تداولات نيويورك كومكس وصدور البيانات الاقتصادية)';
  }
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
        return calculateGoldMetrics(
          item.xauPrice,
          item.chgXau,
          item.pcXau,
          data.date,
          'GoldPrice Global Feed'
        );
      }
    }
    console.warn(`المصدر الأول غير متاح (الحالة: ${res?.status ?? 'خطأ شبكة'})، جاري التحويل للمصدر الثاني...`);
  } catch (err) {
    console.warn(`تعذر الاتصال بالمصدر الأول (${err.message})، جاري التحويل للمصدر الثاني...`);
  }

  try {
    const altRes = await fetchWithRetry('https://api.gold-api.com/price/XAU', {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
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
    session: getMarketSessionContext(),
    date: new Date().toISOString()
  };
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
        if (availableSet.has(modelId) && !candidates.includes(modelId)) {
          candidates.push(modelId);
        }
      }

      for (const id of allModels) {
        if (!candidates.includes(id)) {
          candidates.push(id);
        }
      }
    }
  } catch (err) {
    console.warn('تعذر فحص قائمة نماذج Groq:', err.message);
  }

  for (const fallback of ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']) {
    if (!candidates.includes(fallback)) {
      candidates.push(fallback);
    }
  }

  return candidates;
}

function sanitizeTelegramHtml(text) {
  return text
    .trim()
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^#{1,3}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/&(?!(amp|lt|gt|quot);)/g, '&amp;');
}

async function generateEditorialArticle(gold) {
  const systemPrompt = `أنت خبير اقتصادي بخبرة تزيد عن 20 عامًا في الاقتصاد الكلي والجزئي والأسواق المالية، وفي نفس الوقت كاتب مقالات محترف تكتب لصحف ومجلات اقتصادية كبرى.

مهمتك: كتابة مقال اقتصادي تحليلي معمق وشامل حول حركة أسعار الذهب وتأثيرها على السوق المحلي والعربي، للنشر في قناة تليجرام.

المعايير التحريرية:
- الجمهور المستهدف: القارئ العادي المهتم بالادخار والذهب، وصغار المستثمرين.
- السوق محل التركيز: السوق العالمي وانعكاسه المباشر على مصر والمنطقة العربية.
- النبرة واللغة: تحليلية مبسطة، باللغة العربية الفصحى المعاصرة السلسة (بدون تعقيد أكاديمي وبدون عامية).
- الطول المطلوب: مقال موسع ومتماسك يقارب 1000 كلمة (في حدود 900 إلى 1100 كلمة) مقسم إلى فقرات قصيرة وعناوين فرعية واضحة ومريحة للقراءة على الهاتف.

قواعد الكتابة الصارمة:
1. ابدأ بعنوان خبري جذاب ومقدمة قوية ومشوقة تشد القارئ من أول سطرين.
2. قسّم المقال إلى عناوين فرعية واضحة تغطي: المشهد السعري والبيانات، العوامل الاقتصادية الكلية، انعكاس السوق العالمي على الأسواق المحلية، توازن وجهات النظر في السوق، وخلاصة وتوصية عملية.
3. بسّط المصطلحات الاقتصادية المعقدة (مثل التضخم، أسعار الفائدة، عوائد السندات، والسيولة) بأمثلة واضحة من الواقع اليومي وحياة الناس.
4. الالتزام التام بالأرقام المرفقة فقط؛ لا تخترع أي إحصائيات أو أسعار صرف أو أرقام غير موجودة في البيانات، واذكر بوضوح أن التسعير المحلي يتأثر بعوامل العرض والطلب المحلي وسعر الصرف والمصنعية.
5. اعرض أكثر من وجهة نظر قبل الوصول لرأيك أو تحليلك (مثلاً: رؤية من يراهنون على استمرار الطلب والتحوط مقابل رؤية من يفضلون التريث أو جني الأرباح المرحلي).
6. اربط الأسباب بالنتائج بوضوح (لماذا يحدث هذا التحرك؟ وما أثره الفعلي على قرارات الادخار والشراء والبيع؟).
7. اختم بخلاصة واضحة وتوصية عملية متزنة أو سؤال يفتح التفكير للقراء، مع تنويه قصير في النهاية بأن الأسعار استرشادية وتتغير لحظياً.
8. تجنب الحشو والتكرار والمقدمات الإنشائية المبتذلة، واجعل كل فقرة تضيف فكرة جديدة وملموسة.
9. التنسيق: استخدم وسوم HTML البسيطة فقط للتأكيد: <b>للنص العريض</b> و <i>للنص المائل</i>. يُمنع استخدام علامات Markdown مثل ** أو ## أو الجداول، ولا تطرح أي أسئلة تمهيدية بل اكتب المقال النهائي مباشرة.`;

  const marketBrief = gold.available
    ? `البيانات اللحظية المعتمدة للمقال:
- اتجاه السوق: ${gold.trend} (${gold.trendEmoji})
- سعر الأونصة عالمياً: ${gold.ounceUsd} دولار
- مقدار التغير اليومي: ${gold.changeUsd} دولار (${gold.changePercent})
- السعر العالمي المرجعي للجرام (محسوب رياضياً):
  • عيار 24: ${gold.gram24Usd} دولار
  • عيار 21: ${gold.gram21Usd} دولار
  • عيار 18: ${gold.gram18Usd} دولار
- توقيت الجلسة التداولية: ${gold.session}
- الطابع الزمني للبيانات: ${gold.date}`
    : `البيانات اللحظية المعتمدة للمقال:
- حالة المصدر: تعذر سحب التسعير اللحظي من المزود الخارجي وقت النشر (${gold.date}).
- توقيت الجلسة التداولية: ${gold.session}
- توجيه خاص: ركّز في المقال على تحليل المحركات الاقتصادية لأسعار الذهب وسلوك المدخرين في هذه الفترة دون ذكر أي أرقام سعرية محددة للأونصة أو الجرام.`;

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
        console.warn(lastError.message);
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
        parse
