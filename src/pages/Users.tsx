import { useEffect, useState, type FormEvent } from 'react';
import { api, type AppUser } from '../api';
import { useAuth } from '../auth';
import { Modal } from '../components/Modal';

export default function Users() {
  const { user: me } = useAuth();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  // Ações de alto risco pedem a senha do administrador (reautenticação)
  const [confirming, setConfirming] = useState<{ title: string; run: (pw: string) => Promise<void> } | null>(null);

  const load = () =>
    api<{ users: AppUser[] }>('GET', '/users')
      .then((r) => setUsers(r.users))
      .catch((e) => setError(e.message));
  useEffect(() => void load(), []);

  const ask = (title: string, run: (pw: string) => Promise<void>) => {
    setError('');
    setNotice('');
    setConfirming({ title, run });
  };
  const patch = (u: AppUser, body: Record<string, unknown>, title: string) =>
    ask(title, async (confirmPassword) => {
      await api('PATCH', `/users/${u.id}`, { ...body, confirmPassword });
      load();
    });
  const sendLink = (u: AppUser) =>
    ask(`Enviar link de senha para ${u.name}`, async (confirmPassword) => {
      await api('POST', `/users/${u.id}/invite`, { confirmPassword });
      setNotice(`Link enviado para ${u.email}. Ele vale por 24 horas e só pode ser usado uma vez.`);
      load();
    });

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
        Cada pessoa define a própria senha por um link enviado ao e-mail dela; o administrador nunca define nem vê senhas.
      </p>
      {notice && <p className="ok">{notice}</p>}
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
                  <select value={u.role} disabled={u.id === me?.id} onChange={(e) => patch(u, { role: e.target.value }, `Alterar perfil de ${u.name}`)} aria-label={`Perfil de ${u.name}`}>
                    <option value="operator">Equipe</option>
                    <option value="admin">Administrador</option>
                  </select>
                </td>
                <td>
                  <span className={`chip ${u.active ? 'green' : 'gray'}`}>{u.active ? 'Ativo' : 'Inativo'}</span>
                  {u.mustChangePassword && <span className="chip amber">{u.pendingLink ? 'Aguardando definir senha' : 'Senha pendente'}</span>}
                </td>
                <td className="actions">
                  {u.active && (
                    <button className="btn small" onClick={() => sendLink(u)}>
                      {u.mustChangePassword ? 'Reenviar link' : 'Enviar link de senha'}
                    </button>
                  )}
                  {u.id !== me?.id && (
                    <button className="btn small ghost" onClick={() => patch(u, { active: !u.active }, `${u.active ? 'Desativar' : 'Reativar'} ${u.name}`)}>
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
          onClose={() => {
            setCreating(false);
            load();
          }}
        />
      )}
      {confirming && (
        <ConfirmPasswordModal
          title={confirming.title}
          run={confirming.run}
          onClose={() => setConfirming(null)}
          onDone={() => setConfirming(null)}
        />
      )}
    </section>
  );
}

function UserForm({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('operator');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ email: string; emailSent: boolean } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api<{ emailSent: boolean }>('POST', '/users', { name, email, role, confirmPassword });
      setResult({ email, emailSent: r.emailSent });
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }

  if (result) {
    return (
      <Modal title="Usuário criado" onClose={onClose}>
        {result.emailSent ? (
          <p className="ok">
            Enviamos um link para <strong>{result.email}</strong>. A pessoa define a própria senha por ele (vale por 24 horas, uso único) e depois entra com o código enviado ao mesmo e-mail.
          </p>
        ) : (
          <p className="error">
            O usuário foi criado, mas <strong>não foi possível enviar o e-mail</strong>. Use "Reenviar link" na lista de usuários.
          </p>
        )}
        <div className="row end">
          <button className="btn primary" onClick={onClose}>
            Fechar
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Novo usuário" onClose={onClose}>
      <form onSubmit={submit} className="form-grid">
        <label>
          Nome
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
        <label>
          E-mail (receberá o link e os códigos de acesso)
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Perfil
          <select value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="operator">Equipe (só troca usuário/entrega)</option>
            <option value="admin">Administrador</option>
          </select>
        </label>
        <p className="muted full">Não é preciso definir senha: a pessoa receberá um link para criar a dela.</p>
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
            Criar e enviar link
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
