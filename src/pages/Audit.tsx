import { useEffect, useState } from 'react';
import { api } from '../api';

type AuditEvent = { id: number; at: string; actor: string | null; action: string; target: string | null; result: string; ip: string | null; detail: Record<string, unknown> | null };

const LABELS: Record<string, string> = {
  login_failed: 'Login: senha incorreta',
  login_blocked: 'Login: bloqueado por excesso de tentativas',
  login_password_ok: 'Login: senha aceita (código enviado)',
  login_success: 'Login concluído',
  mfa_failed: 'MFA: código incorreto',
  mfa_blocked: 'MFA: bloqueado',
  logout: 'Logout',
  password_changed: 'Senha alterada',
  password_change_failed: 'Troca de senha recusada',
  reauth_failed: 'Confirmação de senha do admin incorreta',
  user_created: 'Usuário criado',
  user_updated: 'Usuário alterado',
  line_created: 'Linha criada',
  line_updated: 'Linha alterada',
  line_deleted: 'Linha excluída',
  lines_imported: 'Linhas importadas',
  invoice_saved: 'Fatura salva',
  invoice_deleted: 'Fatura removida',
};

export default function Audit() {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [action, setAction] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api<{ events: AuditEvent[] }>('GET', `/audit?limit=200${action ? `&action=${encodeURIComponent(action)}` : ''}`)
      .then((r) => setEvents(r.events))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, [action]);

  return (
    <section>
      <div className="row between wrap">
        <h2>Auditoria de segurança</h2>
        <div className="row">
          <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filtrar por evento">
            <option value="">Todos os eventos</option>
            {Object.entries(LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <button className="btn" onClick={load}>
            Atualizar
          </button>
        </div>
      </div>
      <p className="muted">Últimos 200 eventos. Os registros não são apagados quando uma linha, fatura ou usuário é excluído.</p>
      {error && <p className="error">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Quando</th>
              <th>Evento</th>
              <th>Quem</th>
              <th>Alvo</th>
              <th>Resultado</th>
              <th>IP</th>
              <th>Detalhes</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="muted">
                  Carregando…
                </td>
              </tr>
            )}
            {!loading && events.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  Nenhum evento.
                </td>
              </tr>
            )}
            {events.map((e) => (
              <tr key={e.id}>
                <td className="mono">{new Date(e.at).toLocaleString('pt-BR')}</td>
                <td>{LABELS[e.action] ?? e.action}</td>
                <td>{e.actor ?? '—'}</td>
                <td>{e.target ?? '—'}</td>
                <td>
                  <span className={`chip ${e.result === 'ok' ? 'green' : 'amber'}`}>{e.result === 'ok' ? 'ok' : e.result === 'fail' ? 'falha' : 'bloqueado'}</span>
                </td>
                <td className="mono">{e.ip ?? '—'}</td>
                <td>
                  <code>{e.detail ? JSON.stringify(e.detail) : ''}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
