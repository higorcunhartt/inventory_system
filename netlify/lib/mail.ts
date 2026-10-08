import nodemailer from 'nodemailer';

function smtpTransport() {
  const port = Number(process.env.SMTP_PORT || 587);
  // 465 = TLS implícito; 587/25 = STARTTLS (obrigatório)
  const secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure,
    requireTLS: !secure,
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
}

/** Entrega via SMTP, Resend ou (somente em desenvolvimento local) log no console. `devLog` nunca vai para produção. */
async function deliver(to: string, subject: string, text: string, devLog: string) {
  const from = process.env.MAIL_FROM || process.env.SMTP_USER;

  if (process.env.SMTP_HOST) {
    if (!from) throw new Error('MAIL_FROM ou SMTP_USER precisa estar definido');
    await smtpTransport().sendMail({ from, to, subject, text });
    return;
  }

  const key = process.env.RESEND_API_KEY;
  if (key) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: from || 'Inventário Móvel <onboarding@resend.dev>', to: [to], subject, text }),
    });
    if (!res.ok) throw new Error(`Falha ao enviar e-mail (${res.status}): ${await res.text()}`);
    return;
  }

  if (process.env.NETLIFY_DEV === 'true') {
    console.log(devLog);
    return;
  }
  throw new Error('Envio de e-mail não configurado (defina SMTP_HOST ou RESEND_API_KEY)');
}

export async function sendMfaEmail(to: string, name: string, code: string) {
  // O código fica só no corpo: assunto aparece em pré-visualizações de notificação e telas bloqueadas.
  const subject = 'Seu código de acesso ao Inventário de linhas móveis RTT';
  const text = `Olá, ${name}.\n\nSeu código de verificação do Inventário Móvel é ${code}.\nEle expira em 10 minutos. Se não foi você, ignore este e-mail.`;
  await deliver(to, subject, text, `[DEV] Código MFA para ${to}: ${code}`);
}

/** Link de definição de senha: `invite` (conta nova ou reenvio pelo administrador, 24 h) ou `reset` (esqueci a senha, 1 h). */
export async function sendPasswordLinkEmail(to: string, name: string, link: string, kind: 'invite' | 'reset') {
  const subject = kind === 'invite' ? 'Defina sua senha — Inventário de linhas móveis RTT' : 'Redefinição de senha — Inventário de linhas móveis RTT';
  const intro =
    kind === 'invite'
      ? 'Uma conta foi criada ou liberada para você no Inventário de linhas móveis RTT. Para definir a sua senha, abra o link abaixo.'
      : 'Recebemos um pedido para redefinir a sua senha no Inventário de linhas móveis RTT. Para continuar, abra o link abaixo.';
  const validity = kind === 'invite' ? '24 horas' : '1 hora';
  const text =
    `Olá, ${name}.\n\n${intro}\n\n${link}\n\n` +
    `O link vale por ${validity} e só pode ser usado uma vez. Depois de definir a senha, você entra com o seu e-mail, a senha e um código de verificação enviado a este e-mail.\n\n` +
    `Se você não esperava esta mensagem, ignore-a: nada será alterado.`;
  await deliver(to, subject, text, `[DEV] Link de senha para ${to}: ${link}`);
}
