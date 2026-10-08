import { useState, type FormEvent } from 'react';
import { api, type User } from '../api';
import { useAuth } from '../auth';

export default function Login() {
  const { setUser } = useAuth();
  const [forgot, setForgot] = useState(false);
  const [step, setStep] = useState<'password' | 'code'>('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [mfaToken, setMfaToken] = useState('');
  const [masked, setMasked] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const submitPassword = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ mfaToken: string; email: string }>('POST', '/auth/login', { email, password });
      setMfaToken(r.mfaToken);
      setMasked(r.email);
      setPassword('');
      setStep('code');
    });
  };

  const submitCode = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const r = await api<{ user: User }>('POST', '/auth/verify', { mfaToken, code });
      setUser(r.user);
    });
  };

  const resend = () =>
    run(async () => {
      await api('POST', '/auth/resend', { mfaToken });
      setInfo('Novo código enviado.');
    });

  if (forgot) return <ForgotPassword onBack={() => setForgot(false)} />;

  return (
    <div className="center">
      <div className="card login">
        <img className="login-logo" src="/logo.png" alt="Rema Tip Top" />
        <h1>Inventário de linhas móveis RTT</h1>
        {step === 'password' ? (
          <form onSubmit={submitPassword}>
            <label>
              E-mail
              <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </label>
            <label>
              Senha
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </label>
            {error && <p className="error">{error}</p>}
            <button className="btn primary" disabled={busy}>
              {busy ? 'Verificando…' : 'Continuar'}
            </button>
            <button type="button" className="btn ghost" onClick={() => setForgot(true)}>
              Esqueci minha senha
            </button>
          </form>
        ) : (
          <form onSubmit={submitCode}>
            <p>
              Enviamos um código de 6 dígitos para <strong>{masked}</strong>.
            </p>
            <label>
              Código de verificação
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="\d{6}"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                required
                autoFocus
              />
            </label>
            {error && <p className="error">{error}</p>}
            {info && !error && <p className="muted">{info}</p>}
            <button className="btn primary" disabled={busy || code.length !== 6}>
              {busy ? 'Verificando…' : 'Entrar'}
            </button>
            <div className="row between">
              <button type="button" className="btn ghost" onClick={resend} disabled={busy}>
                Reenviar código
              </button>
              <button type="button" className="btn ghost" onClick={() => { setStep('password'); setCode(''); setError(''); setInfo(''); }}>
                Voltar
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function ForgotPassword({ onBack }: { onBack: () => void }) {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ message: string }>('POST', '/auth/forgot', { email });
      setMessage(r.message);
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
        <h1>Redefinir senha</h1>
        {message ? (
          <>
            <p className="ok">{message}</p>
            <p className="muted">O link vale por 1 hora e só pode ser usado uma vez. Confira também a caixa de spam.</p>
          </>
        ) : (
          <form onSubmit={submit}>
            <label>
              E-mail cadastrado
              <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </label>
            {error && <p className="error">{error}</p>}
            <button className="btn primary" disabled={busy}>
              {busy ? 'Enviando…' : 'Enviar link'}
            </button>
          </form>
        )}
        <button type="button" className="btn ghost" onClick={onBack}>
          Voltar ao login
        </button>
      </div>
    </div>
  );
}
