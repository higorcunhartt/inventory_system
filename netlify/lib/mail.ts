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

export async function sendMfaEmail(to: string, name: string, code: string) {
  // O código fica só no corpo: assunto aparece em pré-visualizações de notificação e telas bloqueadas.
  const subject = 'Seu código de acesso ao Inventário de linhas móveis RTT';
  const text = `Olá, ${name}.\n\nSeu código de verificação do Inventário Móvel é ${code}.\nEle expira em 10 minutos. Se não foi você, ignore este e-mail.`;
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
    console.log(`[DEV] Código MFA para ${to}: ${code}`);
    return;
  }
  throw new Error('Envio de e-mail não configurado (defina SMTP_HOST ou RESEND_API_KEY)');
}
