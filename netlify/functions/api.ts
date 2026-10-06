import type { Config } from '@netlify/functions';
import { handle } from '../lib/app.ts';

export default (req: Request) => handle(req);

export const config: Config = { path: '/api/*' };
