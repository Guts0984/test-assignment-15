import { env } from './config/env';
import { startStub } from './stub';

void startStub({
  smtpPort: env.MAIL_STUB_SMTP_PORT,
  httpPort: env.MAIL_STUB_HTTP_PORT,
  inboundUrl: env.MAIL_STUB_INBOUND_URL,
  inboundSecret: env.INBOUND_WEBHOOK_SECRET,
  mailDomain: env.MAIL_DOMAIN,
  maxMessages: env.MAIL_STUB_MAX_MESSAGES,
  dedupeMessageId: env.MAIL_STUB_DEDUPE_MESSAGE_ID,
  chaos: {
    enabled: env.MAIL_CHAOS,
    seed: env.MAIL_CHAOS_SEED,
    failEvery: env.MAIL_CHAOS_SMTP_FAIL_EVERY,
    autoreplyRate: env.MAIL_CHAOS_AUTOREPLY_RATE,
  },
});
