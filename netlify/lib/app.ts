import { HttpError, json, matchRoute, type Route } from './http.ts';
import { authRoutes } from '../routes/auth.ts';
import { userRoutes } from '../routes/users.ts';
import { lineRoutes } from '../routes/lines.ts';
import { consumptionRoutes } from '../routes/consumption.ts';
import { auditRoutes } from '../routes/audit.ts';

const routes: Route[] = [...authRoutes, ...userRoutes, ...lineRoutes, ...consumptionRoutes, ...auditRoutes];

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function handle(req: Request): Promise<Response> {
  try {
    // Defesa em profundidade contra CSRF (além de SameSite=Strict): mutações exigem o cabeçalho do nosso front
    // e não podem vir de outro site segundo o navegador (Fetch Metadata).
    if (!SAFE_METHODS.has(req.method)) {
      const site = req.headers.get('sec-fetch-site');
      if (req.headers.get('x-requested-with') !== 'inventory-web' || (site && site !== 'same-origin' && site !== 'none')) {
        throw new HttpError(403, 'Requisição não permitida', 'CSRF');
      }
    }
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/(\.netlify\/functions\/api|api)/, '') || '/';
    const { handler, params } = matchRoute(routes, req.method, path);
    return await handler({ req, params, url });
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message, code: err.code }, err.status);
    console.error('Erro não tratado:', err);
    return json({ error: 'Erro interno do servidor' }, 500);
  }
}
