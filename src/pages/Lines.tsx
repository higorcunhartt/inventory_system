import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, type Line } from '../api';
import { useAuth } from '../auth';
import { Modal } from '../components/Modal';
import { formatDate, formatPhone } from '../format';
import { Pagination } from '../components/Pagination';
import { normalizePageSize, paginate } from '../pagination';
import { isSpare, SPARE } from '../assignee';

const PAGE_SIZE_KEY = 'lines.pageSize';
function readPageSize(): number {
  try {
    return normalizePageSize(localStorage.getItem(PAGE_SIZE_KEY));
  } catch {
    return normalizePageSize(null); // armazenamento indisponível (modo privado etc.)
  }
}

const CARRIERS = ['Vivo', 'Claro', 'TIM', 'Oi', 'Algar'];
const TYPE_LABEL = { DADOS: 'Dados', DADOS_VOZ: 'Dados e Voz' } as const;

type Form = { number: string; carrier: string; lineType: 'DADOS' | 'DADOS_VOZ'; account: string; assigneeName: string; project: string; deliveryDate: string; notes: string };
const emptyForm: Form = { number: '', carrier: 'Vivo', lineType: 'DADOS_VOZ', account: '', assigneeName: '', project: '', deliveryDate: '', notes: '' };

export default function Lines() {
  const { user } = useAuth();
  const admin = user?.role === 'admin';
  const [lines, setLines] = useState<Line[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [carrier, setCarrier] = useState('');
  const [project, setProject] = useState('');
  const [type, setType] = useState('');
  const [onlySpare, setOnlySpare] = useState(false);
  const [editing, setEditing] = useState<Line | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [history, setHistory] = useState<Line | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(readPageSize);

  const load = () =>
    api<{ lines: Line[] }>('GET', '/lines')
      .then((r) => setLines(r.lines))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  useEffect(() => void load(), []);

  const carriers = useMemo(() => [...new Set(lines.map((l) => l.carrier))].sort(), [lines]);
  const projects = useMemo(() => [...new Set(lines.map((l) => l.project).filter(Boolean) as string[])].sort(), [lines]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    const digits = t.replace(/\D/g, '');
    return lines.filter((l) => {
      if (carrier && l.carrier !== carrier) return false;
      if (project && l.project !== project) return false;
      if (type && l.lineType !== type) return false;
      if (onlySpare && !isSpare(l.assigneeName)) return false;
      if (!t) return true;
      return (digits && l.number.includes(digits)) || (l.account ?? '').includes(t) || (l.assigneeName ?? '').toLowerCase().includes(t) || (l.project ?? '').toLowerCase().includes(t);
    });
  }, [lines, q, carrier, project, type, onlySpare]);

  // Mudou a busca ou um filtro: volta para a primeira página
  useEffect(() => setPage(1), [q, carrier, project, type, onlySpare]);
  const paged = useMemo(() => paginate(filtered, page, pageSize), [filtered, page, pageSize]);

  const goToPage = (p: number, scrollToTable = false) => {
    setPage(p);
    if (scrollToTable) document.getElementById('lines-table')?.scrollIntoView({ block: 'start' });
  };
  const changePageSize = (n: number) => {
    const size = normalizePageSize(n);
    setPageSize(size);
    setPage(1);
    try {
      localStorage.setItem(PAGE_SIZE_KEY, String(size));
    } catch {
      /* sem armazenamento: vale só nesta visita */
    }
  };

  async function remove(l: Line) {
    if (!confirm(`Excluir a linha ${formatPhone(l.number)}? O histórico de alterações dela também será removido.`)) return;
    try {
      await api('DELETE', `/lines/${l.id}`);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <section>
      <header className="page-banner">
        <h1>Inventário de linhas móveis RTT</h1>
        <p>Controle de linhas de usuários e projetos</p>
      </header>
      <div className="row between wrap">
        <h2>Linhas ({filtered.length}{filtered.length !== lines.length ? ` de ${lines.length}` : ''})</h2>
        {admin && (
          <div className="row">
            <button className="btn" onClick={() => setImporting(true)}>
              Importar CSV
            </button>
            <button className="btn primary" onClick={() => setEditing('new')}>
              + Nova linha
            </button>
          </div>
        )}
      </div>

      <div className="filters">
        <input placeholder="Buscar número, conta, usuário ou projeto…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={carrier} onChange={(e) => setCarrier(e.target.value)} aria-label="Operadora">
          <option value="">Todas as operadoras</option>
          {carriers.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Tipo">
          <option value="">Todos os tipos</option>
          <option value="DADOS">Dados</option>
          <option value="DADOS_VOZ">Dados e Voz</option>
        </select>
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Projeto">
          <option value="">Todos os projetos</option>
          {projects.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={onlySpare} onChange={(e) => setOnlySpare(e.target.checked)} /> Apenas linhas Spare
        </label>
      </div>

      {error && <p className="error">{error}</p>}
      <Pagination paged={paged} onPage={(p) => goToPage(p)} onSize={changePageSize} label="Paginação (acima da tabela)" />
      <div className="table-wrap" id="lines-table">
        <table>
          <thead>
            <tr>
              <th>Número</th>
              <th>Operadora</th>
              <th>Tipo</th>
              <th>Conta</th>
              <th>Usuário</th>
              <th>Local (projeto)</th>
              <th>Entrega</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="muted">
                  Carregando…
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  Nenhuma linha encontrada.
                </td>
              </tr>
            )}
            {paged.items.map((l) => (
              <tr key={l.id}>
                <td className="mono">{formatPhone(l.number)}</td>
                <td>{l.carrier}</td>
                <td>
                  <span className={`chip ${l.lineType === 'DADOS_VOZ' ? 'blue' : 'gray'}`}>{TYPE_LABEL[l.lineType]}</span>
                </td>
                <td className="mono">{l.account ?? '—'}</td>
                <td>{l.assigneeName ?? SPARE}</td>
                <td>{l.project ?? '—'}</td>
                <td>{formatDate(l.deliveryDate)}</td>
                <td className="actions">
                  <button className="btn small" onClick={() => setEditing(l)}>
                    {admin ? 'Editar' : 'Trocar usuário'}
                  </button>
                  <button className="btn small ghost" onClick={() => setHistory(l)}>
                    Histórico
                  </button>
                  {admin && (
                    <button className="btn small ghost danger" onClick={() => remove(l)}>
                      Excluir
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination paged={paged} onPage={(p) => goToPage(p, true)} onSize={changePageSize} label="Paginação (abaixo da tabela)" />

      {editing && (
        <LineForm
          line={editing === 'new' ? null : editing}
          admin={!!admin}
          carriers={[...new Set([...CARRIERS, ...carriers])]}
          projects={projects}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {importing && (
        <ImportModal
          onClose={() => setImporting(false)}
          onDone={() => {
            load();
          }}
        />
      )}
      {history && <HistoryModal line={history} onClose={() => setHistory(null)} />}
    </section>
  );
}

function LineForm({ line, admin, carriers, projects, onClose, onSaved }: { line: Line | null; admin: boolean; carriers: string[]; projects: string[]; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState<Form>(
    line
      ? { number: line.number, carrier: line.carrier, lineType: line.lineType, account: line.account ?? '', assigneeName: line.assigneeName ?? '', project: line.project ?? '', deliveryDate: line.deliveryDate ?? '', notes: line.notes ?? '' }
      : emptyForm,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof Form) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value } as Form);
  const locked = !admin; // equipe só altera usuário e data de entrega

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (!line) await api('POST', '/lines', f);
      else if (admin) await api('PATCH', `/lines/${line.id}`, f);
      else await api('PATCH', `/lines/${line.id}`, { assigneeName: f.assigneeName, deliveryDate: f.deliveryDate });
      onSaved();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={line ? (admin ? 'Editar linha' : 'Trocar usuário / data de entrega') : 'Nova linha'} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <label>
          Número
          <input value={f.number} onChange={set('number')} placeholder="(11) 98765-4321" disabled={locked} required />
        </label>
        <label>
          Operadora
          <input list="carriers" value={f.carrier} onChange={set('carrier')} disabled={locked} required />
          <datalist id="carriers">
            {carriers.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label>
          Tipo de linha
          <select value={f.lineType} onChange={set('lineType')} disabled={locked}>
            <option value="DADOS">Dados</option>
            <option value="DADOS_VOZ">Dados e Voz</option>
          </select>
        </label>
        <label>
          Número da conta (fatura)
          <input value={f.account} onChange={set('account')} disabled={locked} />
        </label>
        <label>
          Usuário da linha
          <input value={f.assigneeName} onChange={set('assigneeName')} placeholder="Deixe vazio para marcar como Spare" autoFocus={!admin} />
        </label>
        <label>
          Local (projeto)
          <input list="projects" value={f.project} onChange={set('project')} disabled={locked} />
          <datalist id="projects">
            {projects.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>
        <label>
          Data de entrega
          <input type="date" value={f.deliveryDate} onChange={set('deliveryDate')} />
        </label>
        <label className="full">
          Observações
          <input value={f.notes} onChange={set('notes')} disabled={locked} />
        </label>
        {locked && <p className="muted full">Seu perfil pode alterar apenas o usuário e a data de entrega.</p>}
        {error && <p className="error full">{error}</p>}
        <div className="row end full">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy}>
            Salvar
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<{ created: number; skipped: number; errors: Array<{ row: number; message: string }> } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError('');
    try {
      setResult(await api('POST', '/lines/import', { csv }));
      onDone();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Importar linhas (CSV)" onClose={onClose}>
      <p className="muted">
        Colunas: <strong>Número; Operadora; Tipo; Conta; Usuário; Projeto; Data de entrega; Observações</strong> (Tipo: "Dados" ou "Dados e Voz"; data: DD/MM/AAAA). Números já cadastrados são ignorados.
      </p>
      <input
        type="file"
        accept=".csv,.txt"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const buf = new Uint8Array(await file.arrayBuffer());
          let text = new TextDecoder('utf-8').decode(buf);
          if (text.includes('�')) text = new TextDecoder('windows-1252').decode(buf);
          setCsv(text);
          setResult(null);
        }}
      />
      {csv && <p className="muted">{csv.split(/\r?\n/).filter(Boolean).length - 1} linha(s) no arquivo.</p>}
      {error && <p className="error">{error}</p>}
      {result && (
        <div>
          <p className="ok">
            {result.created} criada(s), {result.skipped} ignorada(s) (já existiam), {result.errors.length} com erro.
          </p>
          {result.errors.length > 0 && (
            <ul className="errors">
              {result.errors.slice(0, 20).map((er) => (
                <li key={er.row}>
                  Linha {er.row}: {er.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="row end">
        <button className="btn" onClick={onClose}>
          Fechar
        </button>
        <button className="btn primary" onClick={submit} disabled={!csv || busy}>
          {busy ? 'Importando…' : 'Importar'}
        </button>
      </div>
    </Modal>
  );
}

function HistoryModal({ line, onClose }: { line: Line; onClose: () => void }) {
  const [rows, setRows] = useState<Array<{ action: string; assigneeName: string | null; project: string | null; deliveryDate: string | null; changedBy: string | null; changedAt: string }> | null>(null);
  useEffect(() => {
    api('GET', `/lines/${line.id}/history`).then((r) => setRows(r.history));
  }, [line.id]);
  const label: Record<string, string> = { create: 'Criada', import: 'Importada', update: 'Alterada' };
  return (
    <Modal title={`Histórico — ${formatPhone(line.number)}`} onClose={onClose}>
      {!rows ? (
        <p className="muted">Carregando…</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Quando</th>
                <th>Evento</th>
                <th>Usuário</th>
                <th>Projeto</th>
                <th>Entrega</th>
                <th>Por</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{new Date(r.changedAt).toLocaleString('pt-BR')}</td>
                  <td>{label[r.action] ?? r.action}</td>
                  <td>{r.assigneeName ?? '—'}</td>
                  <td>{r.project ?? '—'}</td>
                  <td>{formatDate(r.deliveryDate)}</td>
                  <td>{r.changedBy ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
