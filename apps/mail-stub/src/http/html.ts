import type { StoredMail } from '../store/store';

export const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const mailCard = (m: StoredMail): string => `
<article class="mail" data-testid="mail" data-subject="${escapeHtml(m.subject)}">
  <h3>${escapeHtml(m.subject || '(no subject)')}</h3>
  <p><b>To:</b> ${escapeHtml(m.to.join(', '))} <b>From:</b> ${escapeHtml(m.from)} <small>${escapeHtml(m.receivedAt)}</small></p>
  <details><summary>Headers (${Object.keys(m.headers).length})</summary>
    <table>${Object.entries(m.headers)
      .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`)
      .join('')}</table>
  </details>
  <pre>${escapeHtml(m.text)}</pre>
  ${m.attachments.length === 0 ? '' : `<p>Attachments: ${m.attachments.map((a) => `${escapeHtml(a.filename)} (${a.size} B)`).join(', ')}</p>`}
</article>`;

export const renderPage = (
  mails: readonly StoredMail[],
  chaos: boolean,
  defaults: { mailDomain: string },
): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mail stub</title>
<style>
  body{font-family:system-ui,sans-serif;margin:0;background:#f6f7f9;color:#1c2330}
  header{background:#1c2330;color:#fff;padding:12px 20px;display:flex;gap:16px;align-items:center;flex-wrap:wrap}
  main{display:grid;grid-template-columns:minmax(280px,380px) 1fr;gap:16px;padding:16px}
  @media(max-width:800px){main{grid-template-columns:1fr}}
  form,article{background:#fff;border:1px solid #d9dde4;border-radius:8px;padding:12px;margin-bottom:12px}
  label{display:block;font-size:13px;margin:8px 0 2px} input,textarea{width:100%;box-sizing:border-box;padding:6px;border:1px solid #b9c0cc;border-radius:4px}
  button{margin-top:10px;padding:8px 14px;border:0;border-radius:6px;background:#2459d3;color:#fff;cursor:pointer}
  pre{white-space:pre-wrap;word-break:break-word;background:#f0f2f5;padding:8px;border-radius:4px}
  th{text-align:left;padding-right:12px;vertical-align:top;font-size:12px} td{font-size:12px;word-break:break-all}
  .badge{background:${chaos ? '#c0392b' : '#2e7d32'};padding:2px 8px;border-radius:10px;font-size:12px}
</style></head><body>
<header><strong>Mail stub</strong><span class="badge" data-testid="chaos">chaos ${chaos ? 'ON' : 'off'}</span><a style="color:#9ec1ff" href="/api/messages">JSON</a></header>
<main>
<section>
  <form id="send" method="post" action="/ui/inbound">
    <h2>Send an inbound email to the helpdesk</h2>
    <label>From (customer)<input name="from" value="customer@example.org" required></label>
    <label>To (support mailbox)<input name="to" value="support@${escapeHtml(defaults.mailDomain)}" required></label>
    <label>Subject<input name="subject" value="Hello from the stub" required></label>
    <label>In-Reply-To (optional Message-ID)<input name="inReplyTo"></label>
    <label>Text<textarea name="text" rows="5" required>Hi, I need some help.</textarea></label>
    <button type="submit" data-testid="send-inbound">Send inbound email</button>
  </form>
</section>
<section><h2>Outbound emails (${mails.length})</h2>${mails.length === 0 ? '<p>No emails yet.</p>' : mails.map(mailCard).join('')}</section>
</main></body></html>`;
