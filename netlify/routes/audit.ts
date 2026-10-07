import { sql } from '../lib/db.ts';
import { json, type Route } from '../lib/http.ts';
import { requireUser } from '../lib/auth.ts';
import { str } from '../lib/validate.ts';

export const auditRoutes: Route[] = [
  [
    'GET',
    '/audit',
    async ({ req, url }) => {
      await requireUser(req, { roles: ['admin'] });
      const action = str(url.searchParams.get('action'), 'ação', { max: 60 });
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 300);
      const rows = await sql`
        select id, at, actor_email, action, target, result, ip, detail
        from audit_log
        where (${action}::text is null or action = ${action})
        order by at desc, id desc limit ${limit}`;
      return json({
        events: rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor_email, action: r.action, target: r.target, result: r.result, ip: r.ip, detail: r.detail })),
      });
    },
  ],
];
