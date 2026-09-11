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

// Faturado corporativo (notas ★ FC) vem do SGF. Sem o token, o faturado
// ja publicado no dados.json e mantido e a coleta do RD segue normal.
const SGF_API_URL = (process.env.SGF_API_URL || 'https://financeiro.portale60.com.br').replace(/\/+$/, '');
const SGF_TOKEN = process.env.SGF_INTEGRACAO_TOKEN;

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

// Meta Minima e Meta Desejavel vem de uma planilha do Excel Online, que o
// Actions nao acessa. Mudam raramente, entao reaproveitamos as ja publicadas
// no dados.json. O Faturado dessas mesmas linhas e sobrescrito pelo SGF.
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

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

const semAcento = (texto) => String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();

// Ano e mes correntes no fuso de Sao Paulo (o runner do Actions roda em UTC).
function anoMesSaoPaulo(data = new Date()) {
  const partes = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit' })
    .formatToParts(data);
  return {
    ano: Number(partes.find((p) => p.type === 'year').value),
    mes: Number(partes.find((p) => p.type === 'month').value),
  };
}

async function buscarFaturadoSgf(ano, mes, { url, token, fetchImpl }) {
  let ultimoErro;
  for (let tentativa = 1; tentativa <= 2; tentativa += 1) {
    try {
      const resposta = await fetchImpl(`${url}/api/integracoes/comercial/faturamento?ano=${ano}&mes=${mes}`, {
        headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'dashboard-comercial-actions' },
        signal: AbortSignal.timeout(20000),
      });
      if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
      const corpo = await resposta.json();
      const valor = Number(corpo?.faturamento_corporativo);
      if (!Number.isFinite(valor)) throw new Error('resposta sem faturamento_corporativo');
      return valor;
    } catch (erro) {
      ultimoErro = erro;
      if (tentativa < 2) await espera(3000);
    }
  }
  throw ultimoErro;
}

// Sobrescreve o Faturado de cada mes do ano corrente com a soma das notas
// ★ FC nao canceladas do SGF (mesmo numero do KPI "Corporativo (★ FC)" da tela
// de Faturamento). Mes que falhar mantem o valor anterior: o painel nunca zera
// por instabilidade do SGF.
async function aplicarFaturadoSgf(metas, opcoes = {}) {
  const { url = SGF_API_URL, token = SGF_TOKEN, fetchImpl = fetch, hoje = new Date() } = opcoes;
  if (!token) {
    console.warn('SGF_INTEGRACAO_TOKEN nao definido; mantendo o faturado ja publicado.');
    return 0;
  }

  const { ano, mes: mesAtual } = anoMesSaoPaulo(hoje);
  let atualizados = 0;

  for (let mes = 1; mes <= mesAtual; mes += 1) {
    const nomeMes = MESES[mes - 1];
    const meta = metas.find((m) => {
      const chave = Object.keys(m).find((k) => /^m[eê]s/i.test(k));
      return chave && semAcento(m[chave]) === semAcento(nomeMes);
    });
    if (!meta) {
      console.warn(`SGF: ${nomeMes} sem linha de metas; faturado ignorado.`);
      continue;
    }

    try {
      const valor = await buscarFaturadoSgf(ano, mes, { url, token, fetchImpl });
      const chaveFaturado = Object.keys(meta).find((k) => /^faturado/i.test(k)) || 'Faturado_x003a_';
      const novo = String(Math.round(valor * 100) / 100);
      if (meta[chaveFaturado] !== novo) {
        console.log(`SGF: ${nomeMes}/${ano} faturado ${meta[chaveFaturado]} -> ${novo}`);
        meta[chaveFaturado] = novo;
      }
      atualizados += 1;
    } catch (erro) {
      console.warn(`SGF: ${nomeMes}/${ano} falhou (${erro.message}); mantendo o valor anterior.`);
    }
  }

  console.log(`SGF: ${atualizados} de ${mesAtual} meses lidos.`);
  return atualizados;
}

async function main() {
  if (!TOKEN) {
    console.error('RD_TOKEN nao definido. Cadastre o secret no repositorio.');
    process.exit(1);
  }

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
  await aplicarFaturadoSgf(metas);

  const payload = {
    rd: { deals },
    metas,
    updated_at: new Date().toISOString(),
  };

  fs.writeFileSync(outputPath, JSON.stringify(payload), 'utf8');
  console.log(`Gravado ${outputPath}: ${deals.length} negocios, ${metas.length} metas.`);
}

if (require.main === module) {
  main().catch((erro) => {
    console.error(erro.message);
    process.exit(1);
  });
}

module.exports = { aplicarFaturadoSgf, anoMesSaoPaulo };
