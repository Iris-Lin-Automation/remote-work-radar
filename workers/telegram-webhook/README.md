# Telegram Copilot Webhook (Cloudflare Worker)

See root [`README_CLOUD_DEPLOYMENT.md`](../../README_CLOUD_DEPLOYMENT.md) for full steps.

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ALLOWED_TELEGRAM_USER_ID
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put GROQ_MODEL
npx wrangler deploy
```

Commands: `/help` `/apply` `/review` `/status` `/check <url>` `/prefs` `/confirm <uuid>`
