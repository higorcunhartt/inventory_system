import { sendMfaEmail } from '../netlify/lib/mail.ts';

const to = process.argv[2];
if (!to) {
  console.error('Uso: npm run mail:test -- destino@exemplo.com');
  process.exit(1);
}
try {
  await sendMfaEmail(to, 'Teste', '123456');
  console.log(`E-mail de teste enviado para ${to} (código fictício 123456).`);
} catch (e: any) {
  console.error('Falha no envio:', e.message);
  process.exit(1);
}
