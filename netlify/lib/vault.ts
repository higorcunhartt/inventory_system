import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { HttpError } from './http.ts';

/**
 * Cofre de credenciais (AES-256-GCM). Guarda a conta de e-mail configurada em cada aparelho.
 * - A chave vem de FIELD_ENCRYPTION_KEY (mínimo 32 caracteres aleatórios), separada do JWT_SECRET: trocar uma não afeta a outra.
 * - O id da linha entra como dado autenticado (AAD): o texto cifrado de uma linha não abre em outra.
 * - Formato guardado: v1:<iv>:<tag>:<texto cifrado>, tudo em base64url. Nunca vai para auditoria, histórico, listagens nem logs.
 * Se a chave for perdida, as credenciais guardadas não podem ser recuperadas (é preciso cadastrá-las de novo).
 */
function key(): Buffer {
  const secret = process.env.FIELD_ENCRYPTION_KEY || '';
  if (secret.length < 32) throw new HttpError(503, 'Cofre de credenciais não configurado (defina FIELD_ENCRYPTION_KEY com 32+ caracteres)');
  return Buffer.from(hkdfSync('sha256', secret, 'inventory-system', 'device-account:v1', 32));
}

export type DeviceAccount = { email: string; password: string };

export function sealAccount(lineId: string, acc: DeviceAccount): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  c.setAAD(Buffer.from(lineId));
  const ct = Buffer.concat([c.update(JSON.stringify(acc), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

export function openAccount(lineId: string, sealed: string): DeviceAccount {
  try {
    const [v, iv, tag, ct] = sealed.split(':');
    if (v !== 'v1' || !iv || !tag || !ct) throw new Error('formato');
    const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(lineId));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    const acc = JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8'));
    if (typeof acc?.email !== 'string' || typeof acc?.password !== 'string') throw new Error('conteúdo');
    return acc;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Chave diferente da usada para gravar, dado adulterado ou copiado de outra linha
    throw new HttpError(409, 'Não foi possível abrir as credenciais salvas (chave diferente ou dado alterado). Cadastre-as de novo.');
  }
}
