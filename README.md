# Telegram Message AI Processor

این سرویس به MongoDB شما وصل می‌شود و روی کالکشن `message`، فقط برای اسنادی که **`processor` ندارند** (یا ناقص است)، فیلدهای زیر را اضافه می‌کند — بدون تغییر دادن ساختار قبلی سند:

- `confidence`: همیشه `0`
- `processor`: خروجی AI شامل:
  - `result`: فقط متن خروجی (بدون reasoning)
  - `type`: یکی از `News | Analysis | Signal | Signal-live | Other` (سیگنال‌های خیلی کوتاه/مبهم که ساختار Signal کامل ندارند → `Signal-live`)
  - `type_confidence`: عدد بین 0..1
  - `structure_confidence`: عدد بین 0..1
  - `structure`: ساختار مناسب نوع

## خروجی دقیقاً چه شکلی ذخیره می‌شود؟

نمونه (فقط فیلدهای اضافه‌شده):

```json
{
  "confidence": 0,
  "processor": {
    "result": "…",
    "type": "News",
    "type_confidence": 0.82,
    "structure_confidence": 0.75,
    "structure": { }
  }
}
```

## اجرای محلی (Node.js 18+)

```bash
npm install
npm start
```

## راه‌اندازی با Docker Compose (پیشنهادی برای Dokploy)

1) فایل `.env` بسازید:

- روی ویندوز:
  - `.env.example` را کپی کنید به `.env`
  - مقدارها را تنظیم کنید (خصوصاً `MONGO_URI` و `OPENROUTER_API_KEY`)

2) اجرا:

```bash
docker compose up -d --build
```

لاگ‌ها:

```bash
docker compose logs -f telegram-processor
```

## تنظیمات مهم

- **`MONGO_URI`**: پیشنهاد:
  - `mongodb://administrator:<PASSWORD>@144.172.92.16:27017/?authSource=admin`
- **`OPENROUTER_API_KEY`**: کلید OpenRouter
- **`OPENROUTER_MODEL`**: پیش‌فرض `google/gemma-4-26b-a4b-it:free`
- **`OPENROUTER_QUOTA_COOLDOWN_SECONDS`**: مکث worker بعد از خطای quota/rate limit روزانه OpenRouter؛ پیش‌فرض `1800` ثانیه.
- **Idempotent**: اگر سند قبلاً `processor.result` و `processor.type` داشته باشد دوباره پردازش نمی‌شود.

## نکته امنیتی

کلیدها و پسورد را داخل ریپو نگذارید. فقط داخل `.env` نگه دارید (در `.gitignore` است).

