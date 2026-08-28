// Coleta os negocios do RD Station CRM e monta o payload bruto do dashboard.
//
// Substitui a coleta que era feita no Power Automate por 26 acoes HTTP fixas
// (uma por pagina), que estourava sempre que o CRM passava do teto de paginas.
// Aqui a paginacao segue ate a API dizer que nao ha mais dados.
//
// Uso: RD_TOKEN=xxx node scripts/coletar-rd.js dados.json dados.raw.json
//   - argv[2]: dados.json publicado hoje, usado so para reaproveitar as metas
//   - argv[3]: saida bruta, no formato que sanitize-dashboard-data.js espera

const fs = require('fs');

const metasPath = process.argv[2] || 'dados.json';
const outputPath = process.argv[3] || 'dados.raw.json';

const TOKEN = process.env.RD_TOKEN;
const START_DATE = process.env.RD_START_DATE || '2025-01-01';
const END_DATE = process.env.RD_END_DATE || '2099-12-31';
const LIMIT = 200; // teto da API do RD; pedir mais nao aumenta a pagina
const MAX_PAGINAS = 500; // trava de seguranca contra loop infinito
const TENTATIVAS = 4;

if (!TOKEN) {
  console.error('RD_TOKEN nao definido. Cadastre o secret no repositorio.');
  process.exit(1);
}

function montarUrl(page) {
  const params = new URLSearchParams({
    token: TOKEN,
    limit: String(LIMIT),
    page: String(page),
    order: 'closed_at',
    sort: 'desc',
    closed_at_period: 'true',
    start_date: START_DATE,
    end_date: END_DATE,
  });
  return `https://crm.rdstation.com/api/v1/deals?${params}`;
}

const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function buscarPagina(page) {
  let ultimoErro;
  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa += 1) {
    try {
      const resposta = await fetch(montarUrl(page), {
        headers: { 'User-Agent': 'dashboard-comercial-actions' },
      });
      if (!resposta.ok) {
        throw new Error(`HTTP ${resposta.status} ${resposta.statusText}`);
      }
      return await resposta.json();
    } catch (erro) {
      ultimoErro = erro;
      if (tentativa < TENTATIVAS) {
        const pausa = 2000 * tentativa;
        console.warn(`Pagina ${page}: ${erro.message}. Retentando em ${pausa}ms...`);
        await espera(pausa);
      }
    }
  }
  throw new Error(`Pagina ${page} falhou apos ${TENTATIVAS} tentativas: ${ultimoErro.message}`);
}

// As metas vem de uma planilha do Excel Online, que o Actions nao acessa.
// Elas mudam raramente, entao reaproveitamos as ja publicadas no dados.json.
function lerMetas(path) {
  try {
    const bruto = JSON.parse(fs.readFileSync(path, 'utf8'));
    const raw = typeof bruto === 'string' ? JSON.parse(bruto) : bruto;
    if (Array.isArray(raw?.metas)) return raw.metas;
    if (Array.isArray(raw?.rd?.metas)) return raw.rd.metas;
  } catch (erro) {
    console.warn(`Nao foi possivel reaproveitar as metas de ${path}: ${erro.message}`);
  }
  return [];
}

async function main() {
  const deals = [];
  const vistos = new Set();
  let total = null;

  for (let page = 1; page <= MAX_PAGINAS; page += 1) {
    const corpo = await buscarPagina(page);
    const lote = Array.isArray(corpo?.deals) ? corpo.deals : [];
    if (total === null && typeof corpo?.total === 'number') total = corpo.total;

    for (const deal of lote) {
      const id = deal?.id || deal?._id;
      if (id && vistos.has(id)) continue; // o union do fluxo antigo tambem deduplicava
      if (id) vistos.add(id);
      deals.push(deal);
    }

    console.log(`Pagina ${page}: ${lote.length} negocios (acumulado ${deals.length})`);

    if (!lote.length || corpo?.has_more === false) break;
    if (page === MAX_PAGINAS) {
      throw new Error(`Limite de ${MAX_PAGINAS} paginas atingido sem fim de paginacao.`);
    }
  }

  if (total !== null && deals.length < total) {
    throw new Error(`Coleta incompleta: ${deals.length} de ${total} negocios informados pela API.`);
  }

  const metas = lerMetas(metasPath);
  if (!metas.length) {
    console.warn('Nenhuma meta reaproveitada; o dashboard ficara sem a linha de metas.');
  }

  const payload = {
    rd: { deals },
    metas,
    updated_at: new Date().toISOString(),
  };

  fs.writeFileSync(outputPath, JSON.stringify(payload), 'utf8');
  console.log(`Gravado ${outputPath}: ${deals.length} negocios, ${metas.length} metas.`);
}

main().catch((erro) => {
  console.error(erro.message);
  process.exit(1);
});
