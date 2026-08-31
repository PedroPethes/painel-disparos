// Push diário pro cliente. Assina com HMAC-SHA256 e tenta algumas vezes.
import crypto from 'crypto';
import type { EventOut } from './db';

export interface WebhookPayload {
  date: string; // dia (BR) a que se referem os eventos
  funil: { disparos: number; respostas: number; taxa: number };
  events: EventOut[];
}

/** Assinatura para o cliente validar a autenticidade do corpo. */
export function sign(secret: string, body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** POST com retry+backoff. Nunca lança — retorna sucesso/fracasso (não derruba a ingestão). */
export async function postWebhook(
  url: string, secret: string, payload: WebhookPayload, attempts = 3,
): Promise<boolean> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) headers['X-Signature'] = sign(secret, body);

  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body });
      if (res.ok) return true;
      console.error(`[webhook] tentativa ${i + 1}/${attempts}: HTTP ${res.status}`);
    } catch (e: any) {
      console.error(`[webhook] tentativa ${i + 1}/${attempts}: ${e.message}`);
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  return false;
}
