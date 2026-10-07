import { useEffect, useState, type FormEvent } from 'react';
import { api, type AppUser } from '../api';
import { useAuth } from '../auth';
import { Modal } from '../components/Modal';

export default function Users() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<AppUser | null>(null);
  // Ações de alto risco pedem a senha do administrador (reautenticação)
  const [confirming, setConfirming] = useState<{ title: string; run: (pw: string) => Promise<void> } | null>(null);

  const load = () =>
    api<{ users: AppUser[] }>('GET', '/users')
      .then((r) => setUsers(r.users))
      .catch((e) => setError(e.message));
  useEffect(() => void load(), []);

  async function patch(u: AppUser, body: Record<string, unknown>, confirmPassword: string) {
    setError('');
    await api('PATCH', `/users/${u.id}`, { ...body, confirmPassword });
    load();
  }
  const askAndPatch = (u: AppUser, body: Record<string, unknown>, title: string) =>
    setConfirming({ title, run: (pw) => patch(u, body, pw) });

  return (
    <section>
      <div className="row between wrap">
        <h2>Usuários do sistema</h2>
        <button className="btn primary" onClick={() => setCreating(true)}>
          + Novo usuário
        </button>
      </div>
      <p className="muted">
        <strong>Equipe</strong> pode apenas trocar o usuário e a data de entrega das linhas. <strong>Administrador</strong> tem acesso total, inclusive consumo.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Nome</th>
              <th>E-mail</th>
              <th>Perfil</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>
                  <select value={u.role} disabled={u.id === me?.id} onChange={(e) => askAndPatch(u, { role: e.target.value }, `Alterar perfil de ${u.name}`)} aria-label={`Perfil de ${u.name}`}>
                    <option value="operator">Equipe</option>
                    <option value="admin">Administrador</option>
                  </select>
                </td>
                <td>
                  <span className={`chip ${u.active ? 'green' : 'gray'}`}>{u.active ? 'Ativo' : 'Inativo'}</span>
                  {u.mustChangePassword && <span className="chip amber">Senha temporária</span>}
                </td>
                <td className="actions">
                  <button className="btn small" onClick={() => setResetting(u)}>
                    Redefinir senha
                  </button>
                  {u.id !== me?.id && (
                    <button className="btn small ghost" onClick={() => askAndPatch(u, { active: !u.active }, `${u.active ? 'Desativar' : 'Reativar'} ${u.name}`)}>
                      {u.active ? 'Desativar' : 'Reativar'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {creating && (
        <UserForm
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            load();
          }}
        />
      )}
      {confirming && <ConfirmPasswordModal title={confirming.title} run={confirming.run} onClose={() => setConfirming(null)} onDone={() => { setConfirming(null); }} />}
      {resetting && (
        <UserForm
          user={resetting}
          onClose={() => setResetting(null)}
          onSaved={() => {
            setResetting(null);
            load();
          }}
        />
      )}
    </section>
  );
}

function UserForm({ user, onClose, onSaved }: { user?: AppUser; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('operator');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (user) await api('PATCH', `/users/${user.id}`, { password, confirmPassword });
      else await api('POST', '/users', { name, email, role, password, confirmPassword });
      onSaved();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <Modal title={user ? `Redefinir senha — ${user.name}` : 'Novo usuário'} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        {!user && (
          <>
            <label>
              Nome
              <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
            </label>
            <label>
              E-mail (receberá o código MFA)
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            </label>
            <label>
              Perfil
              <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="operator">Equipe (só troca usuário/entrega)</option>
                <option value="admin">Administrador</option>
              </select>
            </label>
          </>
        )}
        <label>
          Senha temporária (mín. 10 caracteres)
          <input type={show ? 'text' : 'password'} autoComplete="new-password" minLength={10} maxLength={72} value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus={!!user} />
        </label>
        <label className="check">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Mostrar senha
        </label>
        <p className="muted full">O usuário será obrigado a trocar esta senha no primeiro acesso. Evite senhas óbvias ("senha12345").</p>
        <label className="full">
          Sua senha de administrador (confirmação)
          <input type="password" autoComplete="current-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
        </label>
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

function ConfirmPasswordModal({ title, run, onClose, onDone }: { title: string; run: (pw: string) => Promise<void>; onClose: () => void; onDone: () => void }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await run(pw);
      onDone();
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <p className="muted full">Por segurança, confirme a sua senha para continuar.</p>
        <label className="full">
          Sua senha
          <input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required autoFocus />
        </label>
        {error && <p className="error full">{error}</p>}
        <div className="row end full">
          <button type="button" className="btn" onClick={onClose}>
            Cancelar
          </button>
          <button className="btn primary" disabled={busy || !pw}>
            Confirmar
          </button>
        </div>
      </form>
    </Modal>
  );
}
