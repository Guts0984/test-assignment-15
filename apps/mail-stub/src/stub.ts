import type { AddressInfo } from 'node:net';
import { composeRaw } from './inbound/compose';
import { createChaos, type ChaosSettings } from './chaos/chaos';
import { createHttpServer } from './http/server';
import { createDeliverer, type Deliverer } from './inbound/deliver';
import { createSmtpServer, type SmtpStats } from './smtp/smtp-server';
import { createStore, type StoredMail } from './store/store';

export type StubOptions = {
  readonly smtpPort: number;
  readonly httpPort: number;
  readonly inboundUrl: string;
  readonly inboundSecret: string;
  readonly mailDomain: string;
  readonly maxMessages: number;
  readonly chaos: ChaosSettings;
  readonly deliverer?: Deliverer;
};

export type RunningStub = {
  readonly smtpPort: number;
  readonly httpPort: number;
  readonly stats: SmtpStats;
  readonly stop: () => Promise<void>;
};

const addressOf = (s: string): string => /<([^>]+)>/.exec(s)?.[1] ?? s.trim();

/** Wires the SMTP sink, the HTTP UI/API, the store and chaos together. */
export const startStub = async (o: StubOptions): Promise<RunningStub> => {
  const store = createStore(o.maxMessages);
  const chaos = createChaos(o.chaos);
  const stats: SmtpStats = { transactions: 0, failed: 0, delivered: 0 };
  const deliverer = o.deliverer ?? createDeliverer({ url: o.inboundUrl, secret: o.inboundSecret });

  // Chaos: sometimes the customer's mail system answers a sent email with an autoreply or a bounce.
  const respond = (m: StoredMail): void => {
    const kind = chaos.autoResponseFor();
    if (kind === null || m.messageId === null) return;
    const mailbox = addressOf(m.from).toLowerCase();
    const customer = addressOf(m.to[0] ?? '');
    const common = { to: mailbox, inReplyTo: m.messageId, references: [m.messageId] };
    const mail =
      kind === 'autoreply'
        ? composeRaw(
            {
              ...common,
              from: customer,
              subject: `Automatic reply: ${m.subject}`,
              text: 'I am out of the office.',
              headers: { 'Auto-Submitted': 'auto-replied' },
            },
            o.mailDomain,
          )
        : composeRaw(
            {
              ...common,
              from: `MAILER-DAEMON@${o.mailDomain}`,
              subject: 'Undelivered Mail Returned to Sender',
              text: '--b\r\nContent-Type: text/plain\r\n\r\nDelivery failed\r\n--b--',
              headers: {
                'Content-Type': 'multipart/report; report-type=delivery-status; boundary=b',
                'Return-Path': '<>',
              },
            },
            o.mailDomain,
          );
    void deliverer.deliver(mailbox, mail.raw, chaos.shouldDuplicateInbound());
  };

  const smtp = createSmtpServer({
    store,
    chaos,
    now: () => new Date(),
    onAccepted: respond,
    stats,
  });
  const http = createHttpServer({ store, chaos, deliverer, stats, mailDomain: o.mailDomain });
  await new Promise<void>((resolve) => smtp.listen(o.smtpPort, '0.0.0.0', resolve));
  await new Promise<void>((resolve) => http.listen(o.httpPort, '0.0.0.0', resolve));
  const smtpPort = (smtp.server.address() as AddressInfo).port;
  const httpPort = (http.address() as AddressInfo).port;
  return {
    smtpPort,
    httpPort,
    stats,
    stop: () =>
      new Promise<void>((resolve) => {
        http.close(() => smtp.close(() => resolve()));
        http.closeAllConnections();
      }),
  };
};
