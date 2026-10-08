import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';

/** Página aberta pelo link enviado por e-mail (#t=...). O token fica no fragmento e é removido da barra de endereço. */
export default function SetPassword() {
  const [token, setToken] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('t') ?? '';
    setToken(t);
    // tira o token do endereço (histórico, atalhos, capturas de tela)
    window.history.replaceState(null, '', window.location.pathname);
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (next !== confirm) return setError('A confirmação não confere com a nova senha');
    setBusy(true);
    try {
      await api('POST', '/auth/set-password', { token, newPassword: next });
      setDone(true);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center">
      <div className="card login">
        <img className="login-logo" src="/logo.png" alt="Rema Tip Top" />
        <h1>Defina sua senha</h1>
        {done ? (
          <>
            <p className="ok">Senha definida com sucesso.</p>
            <p className="muted">Agora entre com o seu e-mail e a nova senha. Enviaremos um código de verificação para o seu e-mail.</p>
            <a className="btn primary block" href="/">
              Ir para o login
            </a>
          </>
        ) : !token ? (
          <>
            <p className="error">Este link está incompleto. Abra novamente o link do e-mail ou peça um novo.</p>
            <a className="btn block" href="/">
              Voltar ao login
            </a>
          </>
        ) : (
          <form onSubmit={submit}>
            <label>
              Nova senha (10 a 72 caracteres)
              <input type="password" autoComplete="new-password" minLength={10} maxLength={72} value={next} onChange={(e) => setNext(e.target.value)} required autoFocus />
            </label>
            <label>
              Confirmar nova senha
              <input type="password" autoComplete="new-password" minLength={10} maxLength={72} value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </label>
            <p className="muted">Use uma frase longa e única. Evite senhas óbvias como "senha12345".</p>
            {error && <p className="error">{error}</p>}
            <button className="btn primary" disabled={busy}>
              {busy ? 'Salvando…' : 'Salvar senha'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
