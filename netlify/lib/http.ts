export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
      'referrer-policy': 'no-referrer',
      ...headers,
    },
  });
}

export async function readJson(req: Request, maxChars = 6_000_000): Promise<Record<string, any>> {
  if (!(req.headers.get('content-type') || '').includes('application/json')) {
    throw new HttpError(415, 'Content-Type deve ser application/json');
  }
  const text = await req.text();
  if (text.length > maxChars) throw new HttpError(413, 'Corpo da requisição muito grande');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'JSON inválido');
  return value as Record<string, any>;
}

export type Ctx = { req: Request; params: Record<string, string>; url: URL };
export type Handler = (ctx: Ctx) => Promise<Response>;
export type Route = [method: string, pattern: string, handler: Handler];

export function matchRoute(routes: Route[], method: string, path: string) {
  const segs = path.split('/').filter(Boolean);
  let pathMatched = false;
  for (const [m, pattern, handler] of routes) {
    const pSegs = pattern.split('/').filter(Boolean);
    if (pSegs.length !== segs.length) continue;
    const params: Record<string, string> = {};
    const ok = pSegs.every((p, i) => {
      if (p.startsWith(':')) {
        params[p.slice(1)] = decodeURIComponent(segs[i]);
        return true;
      }
      return p === segs[i];
    });
    if (!ok) continue;
    pathMatched = true;
    if (m === method) return { handler, params };
  }
  if (pathMatched) throw new HttpError(405, 'Método não permitido');
  throw new HttpError(404, 'Rota não encontrada');
}
