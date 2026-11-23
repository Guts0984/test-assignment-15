import { createServer } from 'node:http';
import { env } from './config/env';

createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
}).listen(env.MAIL_STUB_HTTP_PORT, '0.0.0.0');
