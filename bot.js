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
    console.warn(`تعذر جلب السعر من المصدر الأول (الحالة: ${res.status})، جاري تجربة مصدر بديل...`);
  } catch (err) {
    console.warn(`خطأ في الاتصال بالمصدر الأول (${err.message})، جاري تجربة مصدر بديل...`);
  }

  try {
    const altRes = await fetch('https://api.gold-api.com/price/XAU', {
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Accept': 'application/json'
      }
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
    console.warn(`تعذر جلب السعر من المصدر البديل (${err.message})`);
  }

  return {
    ounceUsd: 'غير متاح لحظياً عبر المصدر الخارجي',
    changeUsd: '0.00',
    changePercent: '0.00',
    date: new Date().toISOString()
  };
}

async function resolveGroqModel() {
  const preferredModels = [
    'llama-3.3-70b-versatile',
    'llama-3.1-70b-versatile',
    'llama-3.1-8b-instant',
    'gemma2-9b-it',
    'mixtral-8x7b-32768'
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
        if (availableIds.has(modelId)) {
          return modelId;
        }
      }
      if (data.data?.length > 0) {
        return data.data[0].id;
      }
    }
  } catch (err) {
    console.warn('تعذر جلب قائمة النماذج من Groq، سيتم استخدام نموذج افتراضي:', err.message);
  }

  return 'llama-3.1-8b-instant';
}

async function generateArticle(gold) {
  const priceLine = gold.ounceUsd.includes('غير متاح')
    ? `- ملاحظة السعر: لم يتوفر رقم لحظي مباشر من المصدر الخارجي وقت النشر (${gold.date})، فركّز على حركة السوق العامة والعوامل المؤثرة في أسعار الذهب دون اختلاق أرقام سعرية محددة.`
    : `- سعر أونصة الذهب عالمياً: ${gold.ounceUsd} دولار\n- مقدار التغير: ${gold.changeUsd} دولار (${gold.changePercent}%)\n- توقيت البيانات: ${gold.date}`;

  const prompt = `أنت محرر اقتصادي محترف. اكتب مقالاً يومياً قصيراً وجذاباً باللغة العربية الفصحى السلسة للنشر على قناة تليجرام حول حركة أسعار الذهب اليوم بناءً على المعلومات التالية فقط:
${priceLine}

شروط المقال:
1. ابدأ بعنوان جذاب مع إيموجي مناسب.
2. لخّص حركة السوق اليوم (صعود، هبوط، أو استقرار) بلغة واضحة ومباشرة بدون حشو.
3. أضف فقرة توضح أبرز العوامل المؤثرة في السوق وتأثير ذلك على الأسعار المحلية.
4. اختم بتنويه قصير بأن الأسعار استرشادية وتتغير لحظياً.
5. لا تستخدم علامات النجوم المزدوجة (**) بكثرة، واجعل التنسيق مريحاً للقراءة على الهاتف.`;

  const model = await resolveGroqModel();
  console.log('النموذج المختار في Groq:', model);

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'أنت صحفي اقتصادي متخصص في أسواق الذهب والعملات.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.6
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`خطأ من Groq API: ${errText}`);
  }

  const data = await res.json();
  const article = data.choices?.[0]?.message?.content;
  if (!article) throw new Error('لم يتم توليد نص المقال');
  return article.trim();
}

async function sendToTelegram(text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: text
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
  console.log('بيانات السوق المستخدمة:', gold);

  console.log('جاري كتابة المقال عبر Groq...');
  const article = await generateArticle(gold);

  console.log('جاري الإرسال إلى تليجرام...');
  await sendToTelegram(article);
  console.log('تم إرسال المقال بنجاح!');
}

main().catch((err) => {
  console.error('حدث خطأ:', err.message);
  process.exit(1);
});
