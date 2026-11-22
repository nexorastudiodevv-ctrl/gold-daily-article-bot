const CONFIG = {
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  REQUEST_TIMEOUT_MS: 15000,
  TROY_OUNCE_TO_GRAMS: 31.1034768,
  PREFERRED_MODELS: [
    'llama-3.3-70b-versatile',
    'llama-3.1-70b-versatile',
    'qwen-2.5-32b',
    'llama-3.1-8b-instant',
    'gemma2-9b-it'
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

async function resolveGroqModel() {
  try {
    const res = await fetchWithRetry('https://api.groq.com/openai/v1/models', {
      headers: {
        'Authorization': `Bearer ${CONFIG.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }, 1);

    if (res?.ok) {
      const data = await res.json();
      const availableIds = new Set((data.data || []).map((m) => m.id));
      for (const modelId of CONFIG.PREFERRED_MODELS) {
        if (availableIds.has(modelId)) return modelId;
      }
      if (data.data?.length > 0) return data.data[0].id;
    }
  } catch (err) {
    console.warn('تعذر فحص قائمة نماذج Groq، سيتم استخدام النموذج الافتراضي:', err.message);
  }
  return 'llama-3.3-70b-versatile';
}

function sanitizeTelegramHtml(text) {
  return text
    .trim()
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/^#{1,3}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/&(?!(amp|lt|gt|quot);)/g, '&amp;');
}

async function generateEditorialArticle(gold) {
  const systemPrompt = `أنت رئيس تحرير قسم الأسواق والسلع في منصة اقتصادية مرموقة (على غرار اقتصاد الشرق وبلومبرج).
مهمتك: كتابة تقرير تحليلي مكثف، رصين، وجذاب لقراء قناة تليجرام حول حركة الذهب العالمية.

الميثاق التحريري الصارم:
1. الدقة المطلقة: التزم بالأرقام المرفقة حرفياً دون تقريب مخل أو اختلاق أي أرقام إضافية (لا تخترع أسعار صرف محلية أو أسعار فائدة محددة غير مذكورة).
2. الأسلوب الصحفي: لغة عربية فصحى معاصرة رشيقة ومباشرة. ابتعد كلياً عن المقدمات الإنشائية المبتذلة مثل ("في ظل التقلبات الاقتصادية الراهنة"، "يُعد الذهب ملاذاً آمناً منذ القدم"، "مرحباً بكم متابعينا").
3. الهيكل البصري (مُحسّن لقراءة الهاتف):
   - عنوان خبري قوي ومختصر في السطر الأول يبدأ بإيموجي مناسب ويلخص اتجاه السوق.
   - فقرة افتتاحية (Lead) من سطرين تشرح المشهد السعري الحالي وسياق الجلسة التداولية.
   - بطاقة الأرقام الرئيسية في نقاط واضحة ومرتبة.
   - فقرة تحليلية بعنوان فرعي قصير توضح المحركات الكلية للذهب (علاقة الدولار، عوائد السندات، وتوقعات السياسة النقدية) وانعكاس تحرك الأونصة عالمياً على تسعير الأسواق المحلية.
   - خاتمة بسطر واحد كتنويه مهني.
4. التنسيق: استخدم وسوم HTML البسيطة فقط للتأكيد: <b>للنص العريض</b> و <i>للنص المائل</i>. يُمنع استخدام Markdown مثل ** أو ## أو الجداول.`;

  const marketBrief = gold.available
    ? `بيانات السوق الموثقة للنشر:
- حالة الاتجاه: ${gold.trend} (${gold.trendEmoji})
- سعر الأونصة الفوري: ${gold.ounceUsd} دولار
- مقدار ونسبة التغير: ${gold.changeUsd} دولار (${gold.changePercent})
- السعر العالمي المرجعي للجرام (محسوب بدقة):
  • عيار 24: ${gold.gram24Usd} دولار
  • عيار 21: ${gold.gram21Usd} دولار
  • عيار 18: ${gold.gram18Usd} دولار
- السياق الزمني للسوق: ${gold.session}
- الطابع الزمني للبيانات: ${gold.date}`
    : `بيانات السوق الموثقة للنشر:
- حالة المصدر اللحظي: تعذر سحب التسعير اللحظي من المزود الخارجي في هذه اللحظة (${gold.date}).
- السياق الزمني للسوق: ${gold.session}
- التعليمات الخاصة: اكتب تحليلاً سوقياً مكثفاً يركز على العوامل المحركة لأسعار الذهب خلال الجلسة الحالية، دون ذكر أي أرقام سعرية محددة للأونصة أو الجرام.`;

  const userPrompt = `حرر التقرير الصحفي الآن بناءً على المعطيات التالية فقط:\n\n${marketBrief}\n\nالطول المستهدف: بين 140 و 210 كلمات، بفقرات قصيرة (سطران إلى ثلاثة أسطر لكل فقرة).`;

  const model = await resolveGroqModel();
  console.log(`النموذج التحريري المختار: ${model}`);

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
      temperature: 0.45,
      max_tokens: 900
    })
  });

  if (!res?.ok) {
    const errText = res ? await res.text() : 'انقطع الاتصال بخادم Groq';
    throw new Error(`فشل توليد المقال من Groq: ${errText}`);
  }

  const data = await res.json();
  const rawArticle = data.choices?.[0]?.message?.content;
  if (!rawArticle) throw new Error('استجابة Groq فارغة من المحتوى التحريري');

  return sanitizeTelegramHtml(rawArticle);
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

    if (!res?.ok) {
      const errText = res ? await res.text() : 'انقطع الاتصال بخادم تليجرام';
      throw new Error(`فشل الإرسال لتليجرام: ${errText}`);
    }
  }
}

async function main() {
  validateEnvironment();

  console.log('1/3 جاري سحب وحساب مؤشرات الذهب العالمية...');
  const gold = await fetchGoldData();
  console.log('ملخص المؤشرات:', gold);

  console.log('2/3 جاري صياغة التقرير الاقتصادي عبر Groq...');
  const article = await generateEditorialArticle(gold);

  console.log('3/3 جاري النشر في قناة تليجرام...');
  await sendToTelegram(article);
  console.log('تم نشر التقرير الصحفي بنجاح!');
}

main().catch((err) => {
  console.error('❌ توقف التنفيذ بسبب خطأ:', err.message);
  process.exit(1);
});
