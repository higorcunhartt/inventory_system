export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch('/api' + path, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || 'Erro inesperado', data.code);
  return data as T;
}

export type User = { id: string; email: string; name: string; role: 'admin' | 'operator'; mustChangePassword: boolean };
export type AppUser = User & { active: boolean; createdAt: string };
export type Line = {
  id: string;
  number: string;
  carrier: string;
  lineType: 'DADOS' | 'DADOS_VOZ';
  account: string | null;
  assigneeName: string | null;
  project: string | null;
  deliveryDate: string | null;
  notes: string | null;
  updatedAt: string;
};
export type MonthTotal = { month: string; voiceMinutes: number; dataMb: number; amount: number; lines: number };
export type LineConsumption = {
  number: string;
  carrier: string;
  assigneeName: string | null;
  project: string | null;
  lineType: string | null;
  registered: boolean;
  voiceMinutes: number;
  dataMb: number;
  amount: number;
};
export type Mapping = { number: number | null; voice: number | null; data: number | null; amount: number | null };
