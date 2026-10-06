export async function sendMfaEmail(to: string, name: string, code: string) {
  const subject = `Seu código de acesso: ${code}`;
  const text = `Olá, ${name}.\n\nSeu código de verificação do Inventário Móvel é ${code}.\nEle expira em 10 minutos. Se não foi você, ignore este e-mail.`;

  const key = process.env.RESEND_API_KEY;
  if (!key) {
    if (process.env.NETLIFY_DEV === 'true') {
      console.log(`[DEV] Código MFA para ${to}: ${code}`);
      return;
    }
    throw new Error('RESEND_API_KEY não configurada');
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || 'Inventário Móvel <onboarding@resend.dev>',
      to: [to],
      subject,
      text,
    }),
  });
  if (!res.ok) throw new Error(`Falha ao enviar e-mail (${res.status}): ${await res.text()}`);
}
