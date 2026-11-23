import { randomUUID } from 'node:crypto';

export type Part =
  | { name: string; value: string }
  | { name: string; filename: string; content: Buffer; contentType?: string };

/** Builds a multipart/form-data body by hand, so tests can send exactly what a browser (or an attacker) would. */
export const multipart = (
  parts: readonly Part[],
): { body: Buffer; headers: Record<string, string> } => {
  const boundary = `----test${randomUUID()}`;
  const chunks: Buffer[] = [];
  for (const p of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if ('filename' in p) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\nContent-Type: ${p.contentType ?? 'application/octet-stream'}\r\n\r\n`,
        ),
      );
      chunks.push(p.content);
    } else {
      chunks.push(
        Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n${p.value}`),
      );
    }
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
};
