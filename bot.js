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

async function generateArticleAndImagePrompt(gold) {
  const priceLine = gold.ounceUsd.includes('غير متاح')
    ? `- ملاحظة السعر: لم يتوفر رقم لحظي مباشر من المصدر الخارجي وقت النشر (${gold.date})، فركّز على حركة السوق العامة والعوامل المؤثرة في أسعار الذهب دون اختلاق أرقام سعرية محددة.`
    : `- سعر أونصة الذهب عالمياً: ${gold.ounceUsd} دولار\n- مقدار التغير: ${gold.changeUsd} دولار (${gold.changePercent}%)\n- توقيت البيانات: ${gold.date}`;

  const prompt = `أنت محرر اقتصادي محترف. المطلوب منك شيئان بناءً على بيانات الذهب التالية:
${priceLine}

أولاً: اكتب مقالاً يومياً قصيراً وجذاباً باللغة العربية الفصحى السلسة للنشر على قناة تليجرام (بطول حوالي 700 إلى 900 حرف حتى يناسب النشر مع صورة):
- ابدأ بعنوان جذاب مع إيموجي مناسب.
- لخّص حركة السوق اليوم بوضوح بدون حشو.
- أضف فقرة قصيرة عن العوامل المؤثرة وتأثيرها محلياً.
- اختم بتنويه قصير بأن الأسعار استرشادية وتتغير لحظياً.
- لا تستخدم علامات النجوم المزدوجة (**).

ثانياً: في آخر سطر فقط، اكتب وصفاً إنجليزياً قصيراً (15 كلمة كحد أقصى) لتوليد صورة احترافية تعبر عن حالة السوق اليوم (سبائك ذهب، عملات ذهبية، رسم بياني مالي) مسبوقاً بالعلامة IMAGE_PROMPT:
مثال:
IMAGE_PROMPT: Luxury shiny gold bars and gold coins with subtle glowing financial chart in dark elegant background, photorealistic, 4k`;

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
  const fullContent = data.choices?.[0]?.message?.content?.trim();
  if (!fullContent) throw new Error('لم يتم توليد نص المقال');

  const lines = fullContent.split('\n');
  let imagePrompt = 'Luxury shiny gold bullion bars and coins with financial market chart background, photorealistic, editorial style';
  const articleLines = [];

  for (const line of lines) {
    if (line.trim().startsWith('IMAGE_PROMPT:')) {
      const extracted = line.replace('IMAGE_PROMPT:', '').trim();
      if (extracted) imagePrompt = extracted;
    } else {
      articleLines.push(line);
    }
  }

  return {
    article: articleLines.join('\n').trim(),
    imagePrompt
  };
}

async function generateImageBuffer(imagePrompt) {
  const seed = Math.floor(Math.random() * 1000000);
  const encodedPrompt = encodeURIComponent(`${imagePrompt}, no text, no watermark, high quality`);
  const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1280&height=720&seed=${seed}&nologo=true`;

  try {
    console.log('جاري توليد صورة للمقال...');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 35000);

    const res = await fetch(imageUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`تعذر توليد الصورة (الحالة: ${res.status})، سيتم النشر بالنص فقط.`);
      return null;
    }

    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (err) {
    console.warn('تجاوز وقت توليد الصورة أو حدث خطأ، سيتم النشر بالنص فقط:', err.message);
    return null;
  }
}

async function sendTextOnly(text) {
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

async function sendPostToTelegram(article, imageBuffer) {
  if (!imageBuffer) {
    await sendTextOnly(article);
    return;
  }

  // الحد الأقصى لوصف الصورة في تليجرام هو 1024 حرفاً
  const caption = article.length <= 1024 ? article : article.slice(0, 1020) + '...';

  const formData = new FormData();
  formData.append('chat_id', TELEGRAM_CHAT_ID);
  formData.append('caption', caption);
  formData.append('photo', new Blob([imageBuffer], { type: 'image/jpeg' }), 'gold-daily.jpg');

  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`;
  const res = await fetch(url, {
    method: 'POST',
    body: formData
  });

  if (!res.ok) {
    const errText = await res.text();
    console.warn('فشل إرسال الصورة، جاري إرسال النص فقط:', errText);
    await sendTextOnly(article);
    return;
  }

  // إذا كان المقال أطول من 1024 حرفاً نرسل الباقي في رسالة تالية
  if (article.length > 1024) {
    await sendTextOnly(article.slice(1020));
  }
}

async function main() {
  console.log('جاري جلب أسعار الذهب...');
  const gold = await fetchGoldData();
  console.log('بيانات السوق المستخدمة:', gold);

  console.log('جاري كتابة المقال ووصف الصورة عبر Groq...');
  const { article, imagePrompt } = await generateArticleAndImagePrompt(gold);
  console.log('وصف الصورة:', imagePrompt);

  const imageBuffer = await generateImageBuffer(imagePrompt);

  console.log('جاري النشر على قناة تليجرام...');
  await sendPostToTelegram(article, imageBuffer);
  console.log('تم النشر بنجاح!');
}

main().catch((err) => {
  console.error('حدث خطأ:', err.message);
  process.exit(1);
});
