import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import Login from './pages/Login';
import ChangePassword from './pages/ChangePassword';
import Lines from './pages/Lines';
import Users from './pages/Users';
import Consumption from './pages/Consumption';

export default function App() {
  const { user, loading, logout } = useAuth();
  if (loading) return <div className="center muted">Carregando…</div>;
  if (!user) return <Login />;
  if (user.mustChangePassword) return <ChangePassword forced />;

  const admin = user.role === 'admin';
  return (
    <div className="shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="RTT — Inventário de linhas móveis">
          <img src="/logo.png" alt="Rema Tip Top" />
        </a>
        <nav>
          <NavLink to="/" end>
            Linhas
          </NavLink>
          {admin && <NavLink to="/consumo">Consumo</NavLink>}
          {admin && <NavLink to="/usuarios">Usuários</NavLink>}
          <NavLink to="/senha">Minha senha</NavLink>
        </nav>
        <div className="who">
          <span>
            {user.name} <small className="muted">({admin ? 'Administrador' : 'Equipe'})</small>
          </span>
          <button className="btn ghost" onClick={logout}>
            Sair
          </button>
        </div>
      </header>
      <main>
        <Routes>
          <Route path="/" element={<Lines />} />
          {admin && <Route path="/consumo" element={<Consumption />} />}
          {admin && <Route path="/usuarios" element={<Users />} />}
          <Route path="/senha" element={<ChangePassword />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
