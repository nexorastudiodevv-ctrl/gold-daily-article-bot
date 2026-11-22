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
    throw new Error(`متغيرات البيئة التالية مفقودة: ${missing.join(', ')}`); } }  async function fetchWithRetry(url, options = {}, retries = 2, timeoutMs = CONFIG.REQUEST_TIMEOUT_MS) { for (let attempt = 0; attempt <= retries; attempt++) { try { const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) }); if (response.ok) return response;  if (response.status >= 400 && response.status < 500 && response.status !== 429) { return response; } if (attempt === retries) return response; } catch (err) { if (attempt === retries) throw err; } await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); } }  function getMarketSessionContext(now = new Date()) { const day = now.getUTCDay(); const hour = now.getUTCHours();  if (day === 6 \vert{}\vert{} (day === 5 && hour >= 22) \vert{}\vert{} (day === 0 && hour < 22)) { return 'عطلة نهاية الأسبوع للبورصات العالمية (استقرار سعري عند مستويات الإغلاق الأسبوعي)'; } if (hour >= 0 && hour < 7) return 'الجلسة الآسيوية (تداولات طوكيو وشنغهاي)'; if (hour >= 7 && hour < 13) return 'الجلسة الأوروبية (بورصة لندن للمعادن الثمينة)'; if (hour >= 13 && hour < 21) return 'الجلسة الأمريكية (تداولات نيويورك كومكس وصدور البيانات الاقتصادية)'; return 'فترة التداول الهادئة بين الإغلاق الأمريكي والافتتاح الآسيوي'; }  function formatDateLabel(rawDate) { const d = new Date(rawDate \vert{}\vert{} Date.now()); if (Number.isNaN(d.getTime())) return 'DAILY UPDATE'; return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase(); }  function calculateGoldMetrics(ounceUsd, changeUsd, changePercent, rawDate, sourceName) { const ounce = Number(ounceUsd); const chg = Number(changeUsd \vert{}\vert{} 0); const pct = Number(changePercent \vert{}\vert{} 0);  const gram24 = ounce / CONFIG.TROY_OUNCE_TO_GRAMS; const gram21 = gram24 * (21 / 24); const gram18 = gram24 * (18 / 24);  let trend = 'استقرار نسبي'; let trendEn = 'STABLE MARKET'; let trendColor = '#F59E0B'; let trendEmoji = '⚖️';  if (pct > 0.15) { trend = 'صعود'; trendEn = 'BULLISH UPTREND'; trendColor = '#22C55E'; trendEmoji = '📈'; } else if (pct < -0.15) { trend = 'هبوط'; trendEn = 'BEARISH DOWNTREND'; trendColor = '#EF4444'; trendEmoji = '📉'; }  return { available: true, source: sourceName, ounceUsd: ounce.toFixed(2), gram24Usd: gram24.toFixed(2), gram21Usd: gram21.toFixed(2), gram18Usd: gram18.toFixed(2), changeUsd: `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}`, changePercent: `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}\%`, pctNumber: pct, trend, trendEn, trendColor, trendEmoji, dateLabel: formatDateLabel(rawDate), session: getMarketSessionContext(), date: rawDate \vert{}\vert{} new Date().toISOString() }; }  async function fetchGoldData() { try { const res = await fetchWithRetry('https://data-asg.goldprice.org/dbXRates/USD', { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36', 'Referer': 'https://goldprice.org/', 'Accept': 'application/json, text/plain, */*' } });  if (res?.ok) { const data = await res.json(); const item = data.items?.[0]; if (item?.xauPrice) { return calculateGoldMetrics(item.xauPrice, item.chgXau, item.pcXau, data.date, 'GoldPrice Global Feed'); } } } catch (err) { console.warn(`تعذر الاتصال بالمصدر الأول (${err.message})`);
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
    console.warn(`تعذر الاتصال بالمصدر الثاني (${err.message})`); }  return { available: false, pctNumber: 0, trendEn: 'MARKET ANALYSIS', trendColor: '#F59E0B', dateLabel: formatDateLabel(new Date().toISOString()), session: getMarketSessionContext(), date: new Date().toISOString() }; }  async function createGoldCardPng(gold) { const ounceText = gold.available ? `$${gold.ounceUsd}` : 'سعر الذهب';
  const changeText = gold.available ? `${gold.changeUsd}$ (${gold.changePercent})` : 'تقرير يومي'; const g24 = gold.available ? `$${gold.gram24Usd}` : '--';
  const g21 = gold.available ? `$${gold.gram21Usd}` : '--'; const g18 = gold.available ? `$${gold.gram18Usd}` : '--';

  let trendAr = 'استقرار نسبي';
  if (gold.available && gold.pctNumber > 0.15) {
    trendAr = 'صعود السوق';
  } else if (gold.available && gold.pctNumber < -0.15) {
    trendAr = 'هبوط السوق';
  }

  const svg = `
  <svg width="1280" height="720" viewBox="0 0 1280 720" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
        <stop offset="0%" stop-color="#090D16"/>
        <stop offset="55%" stop-color="#111827"/>
        <stop offset="100%" stop-color="#1E293B"/>
      </linearGradient>
      <linearGradient id="gold" x1="0%" y1="0%" x2="100%" y2="0%">
        <stop offset="0%" stop-color="#FEF08A"/>
        <stop offset="50%" stop-color="#F59E0B"/>
        <stop offset="100%" stop-color="#D97706"/>
      </linearGradient>
    </defs>

    <rect width="1280" height="720" fill="url(#bg)"/>
    <rect x="40" y="40" width="1200" height="640" rx="28" fill="#0F172A" fill-opacity="0.82" stroke="#F59E0B" stroke-opacity="0.4" stroke-width="2"/>

    <!-- رأس البطاقة -->
    <rect x="1174" y="84" width="10" height="40" rx="5" fill="url(#gold)"/>
    <text x="1156" y="113" text-anchor="end" direction="rtl" font-family="Noto Sans Arabic, DejaVu Sans, sans-serif" font-size="25" font-weight="bold" fill="#F8FAFC">سهم الذهب | أسعار الذهب</text>
    <text x="84" y="113" text-anchor="start" font-family="Noto Sans Arabic, DejaVu Sans, sans-serif" font-size="22" font-weight="bold" fill="#94A3B8">${gold.dateLabel}</text>

    <!-- السعر الرئيسي -->
    <text x="1176" y="192" text-anchor="end" direction="rtl" font-family="Noto Sans Arabic, DejaVu Sans, sans-serif" font-size="22" font-weight="bold" fill="#F59E0B">سعر الأونصة عالمياً (دولار)</text>
    <text x="1176" y="298" text-anchor="end" font-family="Noto Sans Arabic, DejaVu Sans, sans-serif" font-size="92" font-weight="bold" fill="url(#gold)">${ounceText}</text>

    <!-- شارة التغير والاتجاه -->
    <rect x="8
