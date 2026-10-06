import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';

export default function ChangePassword({ forced = false }: { forced?: boolean }) {
  const { user, setUser, logout } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setDone(false);
    if (next !== confirm) return setError('A confirmação não confere com a nova senha');
    setBusy(true);
    try {
      await api('POST', '/auth/change-password', { currentPassword: current, newPassword: next });
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
      if (user) setUser({ ...user, mustChangePassword: false });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <div className="card login">
      <h2>{forced ? 'Defina uma nova senha' : 'Alterar minha senha'}</h2>
      {forced && <p className="muted">Por segurança, troque a senha temporária antes de continuar.</p>}
      <form onSubmit={submit}>
        <label>
          Senha atual
          <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
        </label>
        <label>
          Nova senha (mín. 10 caracteres)
          <input type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required />
        </label>
        <label>
          Confirmar nova senha
          <input type="password" autoComplete="new-password" minLength={10} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
        {error && <p className="error">{error}</p>}
        {done && <p className="ok">Senha alterada com sucesso.</p>}
        <button className="btn primary" disabled={busy}>
          Salvar nova senha
        </button>
        {forced && (
          <button type="button" className="btn ghost" onClick={logout}>
            Sair
          </button>
        )}
      </form>
    </div>
  );
  return forced ? <div className="center">{form}</div> : form;
}
