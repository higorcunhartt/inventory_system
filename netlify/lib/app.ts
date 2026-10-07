import { HttpError, json, matchRoute, type Route } from './http.ts';
import { authRoutes } from '../routes/auth.ts';
import { userRoutes } from '../routes/users.ts';
import { lineRoutes } from '../routes/lines.ts';
import { consumptionRoutes } from '../routes/consumption.ts';
import { auditRoutes } from '../routes/audit.ts';

const routes: Route[] = [...authRoutes, ...userRoutes, ...lineRoutes, ...consumptionRoutes, ...auditRoutes];

export async function handle(req: Request): Promise<Response> {
  try {
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
