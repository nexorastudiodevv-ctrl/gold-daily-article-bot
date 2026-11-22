/**
 * محرك النشر والتحرير الاقتصادي الآلي لقنوات تليجرام
 * المتطلبات: Node.js 18+ (يدعم fetch و AbortSignal.timeout مدمجاً)
 */

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

/**
 * التحقق من وجود مفاتيح التشغيل الأساسية قبل البدء
 */
function validateEnvironment() {
  const missing = ['GROQ_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'].filter(
    (key) => !CONFIG[key] || !CONFIG[key].trim()
  );
  if (missing.length > 0) {
    throw new Error(`متغيرات البيئة التالية مفقودة: ${missing.join(', ')}`);
  }
}

/**
 * دالة جلب مرنة مع مهلة زمنية وإعادة محاولة تلقائية
 */
async function fetchWithRetry(url, options = {}, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(CONFIG.REQUEST_TIMEOUT_MS)
      });
      if (response.ok) return response;

      // لا داعي لإعادة المحاولة عند أخطاء المصادقة أو الطلب الخاطئ
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

/**
 * تحديد حالة السوق والجلسة التداولية الحالية بتوقيت غرينتش لإثراء السياق التحريري
 */
function getMarketSessionContext(now = new Date()) {
  const day = now.getUTCDay(); // 0 = الأحد, 5 = الجمعة, 6 = السبت
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

/**
 * حساب أسعار الجرام العالمية بدقة رياضية مسبقة لمنع أخطاء الحساب في الذكاء الاصطناعي
 */
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
