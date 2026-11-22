const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// 1. جلب بيانات أسعار الذهب العالمية
async function fetchGoldData() {
  const res = await fetch('https://data-asg.goldprice.org/dbXRates/USD');
  if (!res.ok) throw new Error(`فشل جلب الأسعار: ${res.status}`);
  const data = await res.json();
  const item = data.items?.[0];
  if (!item || !item.xauPrice) throw new Error('بيانات السعر غير متوفرة حالياً');

  return {
    ounceUsd: item.xauPrice.toFixed(2),
    changeUsd: item.chgXau.toFixed(2),
    changePercent: item.pcXau.toFixed(2),
    date: data.date
  };
}

// 2. توليد المقال باستخدام Groq API
async function generateArticle(gold) {
  const prompt = `أنت محرر اقتصادي محترف. اكتب مقالاً يومياً قصيراً وجذاباً باللغة العربية الفصحى السلسة للنشر على قناة تليجرام حول حركة أسعار الذهب اليوم بناءً على البيانات التالية فقط:
- سعر أونصة الذهب عالمياً: ${gold.ounceUsd} دولار
- مقدار التغير: ${gold.changeUsd} دولار (${gold.changePercent}%)
- توقيت البيانات: ${gold.date}

شروط المقال:
1. ابدأ بعنوان جذاب مع إيموجي مناسب.
2. لخّص حركة السوق اليوم (صعود، هبوط، أو استقرار) بلغة واضحة ومباشرة بدون حشو.
3. أضف فقرة توضح أبرز العوامل المؤثرة في السوق وتأثير ذلك على الأسعار المحلية.
4. اختم بتنويه قصير بأن الأسعار استرشادية وتتغير لحظياً.
5. لا تستخدم علامات النجوم المزدوجة (**) بكثرة، واجعل التنسيق مريحاً للقراءة على الهاتف.`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
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

// 3. إرسال المقال إلى تليجرام
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
  console.log('تم جلب البيانات:', gold);

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
