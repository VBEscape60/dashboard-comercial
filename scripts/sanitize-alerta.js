// Reduz alerta.json aos campos que o painel usa (sem contatos, e-mails ou telefones).
const fs = require('fs');
const caminho = process.argv[2] || 'alerta.json';
let a = JSON.parse(fs.readFileSync(caminho, 'utf8'));
if (typeof a === 'string') a = JSON.parse(a);
const seguro = {
  _id: a?._id || '',
  id: a?.id || '',
  name: a?.name || '',
  closed_at: a?.closed_at || '',
  updated_at: a?.updated_at || '',
  organization: { name: a?.organization?.name || '' },
  user: { name: a?.user?.name || '' },
};
const novo = JSON.stringify(seguro);
if (fs.readFileSync(caminho, 'utf8').trim() !== novo) fs.writeFileSync(caminho, novo, 'utf8');
