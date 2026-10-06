import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { api, type LineConsumption, type Mapping, type MonthTotal } from '../api';
import { BarChart } from '../components/BarChart';
import { currentMonth, downloadCsv, formatData, formatMinutes, formatMoney, formatMonth, formatPhone } from '../format';

type Preview = {
  format: 'pdf' | 'csv' | 'xlsx';
  headers: string[] | null;
  mapping: Mapping | null;
  detectedMonth: string | null;
  detectedCarrier: string | null;
  warnings: string[];
  totals: { lines: number; registered: number; voiceMinutes: number; dataMb: number; amount: number };
  records: Array<{ number: string; voiceMinutes: number; dataMb: number; amount: number; registered: boolean }>;
};
type Invoice = { id: string; carrier: string; month: string; filename: string; totalAmount: number; uploadedBy: string; uploadedAt: string; lines: number };

const CARRIERS = ['Vivo', 'Claro', 'TIM', 'Oi', 'Algar'];
const MAX_BYTES = 4_300_000;

function toBase64(buf: ArrayBuffer): string {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export default function Consumption() {
  const [refresh, setRefresh] = useState(0);
  return (
    <section>
      <h2>Análise de consumo</h2>
      <Upload onSaved={() => setRefresh((n) => n + 1)} />
      <Analysis refresh={refresh} />
      <Invoices refresh={refresh} onChanged={() => setRefresh((n) => n + 1)} />
    </section>
  );
}

function Upload({ onSaved }: { onSaved: () => void }) {
  const [file, setFile] = useState<{ name: string; b64: string } | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [mapping, setMapping] = useState<Mapping | null>(null);
  const [carrier, setCarrier] = useState('Vivo');
  const [refMonth, setRefMonth] = useState(currentMonth(-1));
  const [error, setError] = useState('');
  const [okMsg, setOkMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const parse = useCallback(async (f: { name: string; b64: string }, m: Mapping | null, first: boolean) => {
    setBusy(true);
    setError('');
    try {
      const p = await api<Preview>('POST', '/consumption/parse', { filename: f.name, contentBase64: f.b64, mapping: m ?? undefined });
      setPreview(p);
      setMapping(p.mapping);
      if (first) {
        if (p.detectedCarrier) setCarrier(p.detectedCarrier);
        if (p.detectedMonth) setRefMonth(p.detectedMonth);
      }
    } catch (e: any) {
      setPreview(null);
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }, []);

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    setOkMsg('');
    setPreview(null);
    if (f.size > MAX_BYTES) return setError('Arquivo muito grande (máximo ~4 MB). Exporte o detalhamento em CSV/XLSX ou divida a fatura.');
    const next = { name: f.name, b64: toBase64(await f.arrayBuffer()) };
    setFile(next);
    parse(next, null, true);
  }

  async function save() {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const r = await api<{ lines: number }>('POST', '/consumption/invoices', {
        filename: file.name,
        contentBase64: file.b64,
        carrier,
        referenceMonth: refMonth,
        mapping: mapping ?? undefined,
      });
      setOkMsg(`Fatura salva: ${r.lines} linha(s) de ${carrier} em ${formatMonth(refMonth)}.`);
      setFile(null);
      setPreview(null);
      onSaved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const setCol = (k: keyof Mapping) => (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = { ...(mapping as Mapping), [k]: e.target.value === '' ? null : Number(e.target.value) };
    setMapping(next);
    if (file) parse(file, next, false);
  };

  return (
    <div className="card">
      <div className="row between wrap">
        <h3>Enviar fatura</h3>
        <label className="btn primary file-btn">
          Subir fatura (PDF, CSV ou XLSX)
          <input type="file" accept=".pdf,.csv,.txt,.xlsx" onChange={pick} hidden />
        </label>
      </div>
      {okMsg && <p className="ok">{okMsg}</p>}
      {error && <p className="error">{error}</p>}
      {busy && <p className="muted">Processando…</p>}
      {preview && file && (
        <>
          <p>
            <strong>{file.name}</strong> — {preview.totals.lines} linha(s), {preview.totals.registered} cadastrada(s) no inventário.
          </p>
          {preview.warnings.map((w) => (
            <p key={w} className="warn">
              ⚠ {w}
            </p>
          ))}
          <div className="form-grid">
            <label>
              Operadora
              <input list="inv-carriers" value={carrier} onChange={(e) => setCarrier(e.target.value)} />
              <datalist id="inv-carriers">
                {CARRIERS.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </label>
            <label>
              Mês de referência
              <input type="month" value={refMonth} onChange={(e) => setRefMonth(e.target.value)} />
            </label>
            {preview.headers && mapping && (
              <>
                {(['number', 'voice', 'data', 'amount'] as const).map((k) => (
                  <label key={k}>
                    Coluna de {{ number: 'número', voice: 'voz (minutos)', data: 'dados', amount: 'valor (R$)' }[k]}
                    <select value={mapping[k] ?? ''} onChange={setCol(k)}>
                      <option value="">— não usar —</option>
                      {preview.headers!.map((h, i) => (
                        <option key={i} value={i}>
                          {h || `Coluna ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </>
            )}
          </div>
          <div className="kpis">
            <Kpi label="Voz" value={formatMinutes(preview.totals.voiceMinutes)} />
            <Kpi label="Dados" value={formatData(preview.totals.dataMb)} />
            <Kpi label="Valor" value={formatMoney(preview.totals.amount)} />
          </div>
          <div className="table-wrap short">
            <table>
              <thead>
                <tr>
                  <th>Número</th>
                  <th>Voz</th>
                  <th>Dados</th>
                  <th>Valor</th>
                  <th>Inventário</th>
                </tr>
              </thead>
              <tbody>
                {preview.records.slice(0, 50).map((r) => (
                  <tr key={r.number}>
                    <td className="mono">{formatPhone(r.number)}</td>
                    <td>{formatMinutes(r.voiceMinutes)}</td>
                    <td>{formatData(r.dataMb)}</td>
                    <td>{formatMoney(r.amount)}</td>
                    <td>{r.registered ? <span className="chip green">Cadastrada</span> : <span className="chip amber">Não cadastrada</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.records.length > 50 && <p className="muted">Mostrando 50 de {preview.totals.lines}.</p>}
          <div className="row end">
            <button className="btn" onClick={() => { setFile(null); setPreview(null); }}>
              Descartar
            </button>
            <button className="btn primary" onClick={save} disabled={busy || !preview.records.length || !carrier || !refMonth}>
              Salvar no histórico
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className="kpi">
      <span className="muted">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Analysis({ refresh }: { refresh: number }) {
  const [from, setFrom] = useState(currentMonth(-5));
  const [to, setTo] = useState(currentMonth(0));
  const [carrier, setCarrier] = useState('');
  const [project, setProject] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState<{ months: MonthTotal[]; lines: LineConsumption[]; projects: string[]; carriers: string[] } | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [detail, setDetail] = useState<Array<{ month: string; voiceMinutes: number; dataMb: number; amount: number; assigneeName: string | null; project: string | null }> | null>(null);

  useEffect(() => {
    if (!from || !to) return;
    const p = new URLSearchParams({ from, to });
    if (carrier) p.set('carrier', carrier);
    if (project) p.set('project', project);
    api('GET', `/consumption/summary?${p}`)
      .then((d) => {
        setData(d);
        setError('');
      })
      .catch((e) => setError(e.message));
    setOpen(null);
  }, [from, to, carrier, project, refresh]);

  async function toggle(number: string) {
    if (open === number) return setOpen(null);
    setOpen(number);
    setDetail(null);
    const r = await api('GET', `/consumption/lines/${number}?from=${from}&to=${to}`);
    setDetail(r.months);
  }

  const lines = useMemo(() => {
    const t = q.trim().toLowerCase();
    const digits = t.replace(/\D/g, '');
    return (data?.lines ?? []).filter((l) => !t || (digits && l.number.includes(digits)) || (l.assigneeName ?? '').toLowerCase().includes(t) || (l.project ?? '').toLowerCase().includes(t));
  }, [data, q]);

  const totals = useMemo(
    () => (data?.months ?? []).reduce((a, m) => ({ voice: a.voice + m.voiceMinutes, data: a.data + m.dataMb, amount: a.amount + m.amount }), { voice: 0, data: 0, amount: 0 }),
    [data],
  );

  return (
    <div className="card">
      <h3>Histórico de consumo</h3>
      <div className="filters">
        <label className="inline">
          De <input type="month" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="inline">
          Até <input type="month" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <select value={carrier} onChange={(e) => setCarrier(e.target.value)} aria-label="Operadora">
          <option value="">Todas as operadoras</option>
          {data?.carriers.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select value={project} onChange={(e) => setProject(e.target.value)} aria-label="Projeto">
          <option value="">Todos os projetos</option>
          {data?.projects.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </div>
      {error && <p className="error">{error}</p>}
      {data && (
        <>
          <div className="kpis">
            <Kpi label="Voz no período" value={formatMinutes(totals.voice)} />
            <Kpi label="Dados no período" value={formatData(totals.data)} />
            <Kpi label="Valor no período" value={formatMoney(totals.amount)} />
            <Kpi label="Linhas com consumo" value={String(data.lines.length)} />
          </div>
          <div className="charts">
            <BarChart title="Dados por mês" data={data.months.map((m) => ({ label: formatMonth(m.month), value: m.dataMb }))} format={formatData} />
            <BarChart title="Voz por mês" data={data.months.map((m) => ({ label: formatMonth(m.month), value: m.voiceMinutes }))} format={formatMinutes} />
          </div>
          <div className="row between wrap">
            <input className="grow" placeholder="Buscar número, usuário ou projeto…" value={q} onChange={(e) => setQ(e.target.value)} />
            <button
              className="btn"
              onClick={() =>
                downloadCsv(`consumo_${from}_${to}.csv`, [
                  ['Número', 'Operadora', 'Usuário', 'Projeto', 'Voz (min)', 'Dados (MB)', 'Valor (R$)'],
                  ...lines.map((l) => [l.number, l.carrier, l.assigneeName ?? '', l.project ?? '', l.voiceMinutes.toFixed(2).replace('.', ','), l.dataMb.toFixed(2).replace('.', ','), l.amount.toFixed(2).replace('.', ',')]),
                ])
              }
            >
              Exportar CSV
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Número</th>
                  <th>Operadora</th>
                  <th>Usuário</th>
                  <th>Projeto</th>
                  <th>Voz</th>
                  <th>Dados</th>
                  <th>Valor</th>
                </tr>
              </thead>
              <tbody>
                {lines.length === 0 && (
                  <tr>
                    <td colSpan={7} className="muted">
                      Nenhum consumo no período. Suba uma fatura acima.
                    </td>
                  </tr>
                )}
                {lines.map((l) => (
                  <Fragment key={l.number}>
                    <tr className="clickable" onClick={() => toggle(l.number)}>
                      <td className="mono">
                        {open === l.number ? '▾' : '▸'} {formatPhone(l.number)} {!l.registered && <span className="chip amber">Não cadastrada</span>}
                      </td>
                      <td>{l.carrier}</td>
                      <td>{l.assigneeName ?? '—'}</td>
                      <td>{l.project ?? '—'}</td>
                      <td>{formatMinutes(l.voiceMinutes)}</td>
                      <td>{formatData(l.dataMb)}</td>
                      <td>{formatMoney(l.amount)}</td>
                    </tr>
                    {open === l.number && (
                      <tr>
                        <td colSpan={7} className="detail">
                          {!detail ? (
                            'Carregando…'
                          ) : (
                            <table>
                              <thead>
                                <tr>
                                  <th>Mês</th>
                                  <th>Usuário na época</th>
                                  <th>Projeto</th>
                                  <th>Voz</th>
                                  <th>Dados</th>
                                  <th>Valor</th>
                                </tr>
                              </thead>
                              <tbody>
                                {detail.map((m) => (
                                  <tr key={m.month}>
                                    <td>{formatMonth(m.month)}</td>
                                    <td>{m.assigneeName ?? '—'}</td>
                                    <td>{m.project ?? '—'}</td>
                                    <td>{formatMinutes(m.voiceMinutes)}</td>
                                    <td>{formatData(m.dataMb)}</td>
                                    <td>{formatMoney(m.amount)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Invoices({ refresh, onChanged }: { refresh: number; onChanged: () => void }) {
  const [rows, setRows] = useState<Invoice[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ invoices: Invoice[] }>('GET', '/consumption/invoices')
      .then((r) => setRows(r.invoices))
      .catch((e) => setError(e.message));
  }, [refresh]);

  async function remove(i: Invoice) {
    if (!confirm(`Remover a fatura "${i.filename}" (${i.carrier}, ${formatMonth(i.month)}) e todo o consumo importado dela?`)) return;
    try {
      await api('DELETE', `/consumption/invoices/${i.id}`);
      onChanged();
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div className="card">
      <h3>Faturas enviadas</h3>
      {error && <p className="error">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Mês</th>
              <th>Operadora</th>
              <th>Arquivo</th>
              <th>Linhas</th>
              <th>Valor</th>
              <th>Enviada por</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  Nenhuma fatura enviada ainda.
                </td>
              </tr>
            )}
            {rows.map((i) => (
              <tr key={i.id}>
                <td>{formatMonth(i.month)}</td>
                <td>{i.carrier}</td>
                <td>{i.filename}</td>
                <td>{i.lines}</td>
                <td>{formatMoney(i.totalAmount)}</td>
                <td>
                  {i.uploadedBy} <small className="muted">{new Date(i.uploadedAt).toLocaleDateString('pt-BR')}</small>
                </td>
                <td className="actions">
                  <button className="btn small ghost danger" onClick={() => remove(i)}>
                    Remover
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
