const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function fetchGoldData() {
  try {
    const res = await fetch('https://data-asg.goldprice.org/dbXRates/USD', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': 'https://goldprice.org/',
        'Accept': 'application/json, text/plain, */*'
      }
    });

    if (res.ok) {
      const data = await res.json();
      const item = data.items?.[0];
      if (item && item.xauPrice) {
        return {
          ounceUsd: Number(item.xauPrice).toFixed(2),
          changeUsd: Number(item.chgXau || 0).toFixed(2),
          changePercent: Number(item.pcXau || 0).toFixed(2),
          date: data.date || new Date().toISOString()
        };
      }
    }
  } catch (err) {
    console.warn('تعذر جلب السعر من المصدر الأول:', err.message);
  }

  try {
    const altRes = await fetch('https://api.gold-api.com/price/XAU', {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    if (altRes.ok) {
      const altData = await altRes.json();
      const price = altData.price ?? altData.xauPrice;
      if (price) {
        return {
          ounceUsd: Number(price).toFixed(2),
          changeUsd: Number(altData.ch ?? altData.change ?? 0).toFixed(2),
          changePercent: Number(altData.chp ?? altData.change_percent ?? 0).toFixed(2),
          date: altData.updatedAt || altData.timestamp || new Date().toISOString()
        };
      }
    }
  } catch (err) {
    console.warn('تعذر جلب السعر من المصدر البديل:', err.message);
  }

  return {
    ounceUsd: null,
    changeUsd: null,
    changePercent: null,
    date: new Date().toISOString()
  };
}

async function resolveGroqModel() {
  const preferredModels = [
    'llama-3.3-70b-versatile',
    'llama-3.1-70b-versatile',
    'llama-3.1-8b-instant',
    'gemma2-9b-it'
  ];

  try {
    const res = await fetch('https://api.groq.com/openai/v1/models', {
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    if (res.ok) {
      const data = await res.json();
      const availableIds = new Set((data.data || []).map((m) => m.id));
      for (const modelId of preferredModels) {
        if (availableIds.has(modelId)) return modelId;
      }
      if (data.data?.length > 0) return data.data[0].id;
    }
  } catch (err) {
    console.warn('استخدام النموذج الافتراضي:', err.message);
  }

  return 'llama-3.1-8b-instant';
}

function formatReadableDate(isoOrText) {
  const d = new Date(isoOrText);
  if (Number.isNaN(d.getTime())) return isoOrText || '';
  return d.toLocaleString('ar-EG', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

async function generateArticle(gold) {
  const readableTime = formatReadableDate(gold.date);
  const marketSnapshot = gold.ounceUsd
    ? `سعر الأونصة: ${gold.ounceUsd} دولار | التغير: ${gold.changeUsd} دولار (${gold.changePercent}%) | التحديث: ${readableTime}`
    : `السعر اللحظي غير متوفر حالياً | التحديث: ${readableTime}`;

  const prompt = `اكتب منشوراً اقتصادياً مختصراً وأنيقاً لقناة "سهم الذهب" على تليجرام باللغة العربية الفصحى الواضحة.
البيانات المتاحة:
${marketSnapshot}

التزم تماماً بالتنسيق التالي دون إضافة مقدمات أو عناوين شرحية:
1. السطر الأول: عنوان خبري مباشر وقوي ينتهي بإيموجي مثل 🥇 أو 📈 أو 📉 (لا تكتب كلمة "عنوان:" ولا كلمة "إيموجي").
2. سطر فارغ ثم فقرة واحدة مركزة (3 أسطر كحد أقصى) تصف حركة الذهب الحالية وما يعكسه ذلك على المتعاملين، بأسلوب صحفي رصين وخالٍ من الحشو والافتتاحيات المكررة مثل "في عالم الاقتصاد".
3. سطر فارغ ثم نقطتان فقط تبدآن بعلامة "•":
• أبرز المحركات: (اذكر عاملين مؤثرين باختصار مثل الدولار، الفائدة، التوترات، أو الطلب).
• نظرة السوق: (الخلاصة العملية للمشتري أو المتابع).
4. سطر فارغ ثم سطر البيانات:
💵 ${gold.ounceUsd ? `الأونصة: ${gold.ounceUsd}$ (${gold.changePercent}%)` : 'متابعة مستمرة لحركة السوق'}
5. سطر فارغ ثم تنويه مختصر:
ℹ️ الأسعار استرشادية وتتغير لحظياً — سهم الذهب.

مهم جداً: لا تستخدم علامات النجوم (**) ولا تتجاوز 750 حرفاً.`;

  const model = await resolveGroqModel();

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: 'system',
          content: 'أنت كاتب تقارير اقتصادية مختص في أسواق الذهب والعملات. تكتب بلغة عربية واضحة، موجزة، واحترافية دون حشو أو قوالب إنشائية مكررة.'
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.5
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`خطأ من Groq API: ${errText}`);
  }

  const data = await res.json();
  const article = data.choices?.[0]?.message?.content?.trim();
  if (!article) throw new Error('لم يتم توليد نص المقال');

  return article.replace(/\*\*/g, '');
}

async function sendToTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`فشل الإرسال لتليجرام: ${errText}`);
  }
}

async function main() {
  console.log('جاري جلب أسعار الذهب...');
  const gold = await fetchGoldData();
  console.log('بيانات السوق:', gold);

  console.log('جاري صياغة المقال...');
  const article = await generateArticle(gold);

  console.log('جاري الإرسال إلى قناة تليجرام...');
  await sendToTelegram(article);
  console.log('تم النشر بنجاح!');
}

main().catch((err) => {
  console.error('حدث خطأ:', err.message);
  process.exit(1);
});
