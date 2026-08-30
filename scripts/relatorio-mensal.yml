const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const fs = require("fs");
const path = require("path");
const { ChartJSNodeCanvas } = require("chartjs-node-canvas");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const REPORT_UID = process.env.REPORT_UID;
const FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

const ZAPI_INSTANCE_ID = process.env.ZAPI_INSTANCE_ID;
const ZAPI_TOKEN = process.env.ZAPI_TOKEN;
const WHATSAPP_TO = process.env.WHATSAPP_TO;
const ZAPI_CLIENT_TOKEN = process.env.ZAPI_CLIENT_TOKEN || "";

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!TELEGRAM_CHAT_ID) throw new Error("Missing TELEGRAM_CHAT_ID");
if (!FIREBASE_PROJECT_ID) throw new Error("Missing FIREBASE_PROJECT_ID");
if (!REPORT_UID) throw new Error("Missing REPORT_UID");
if (!FIREBASE_SERVICE_ACCOUNT_JSON) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");

// Valida uma env var numérica opcional. Se estiver ausente, usa o default;
// se estiver presente mas não for um número válido, falha alto (em vez de
// virar NaN e quebrar silenciosamente a lógica de alerta).
function parseNumericEnv(name, raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (Number.isNaN(value)) {
    throw new Error(`Env var inválida: ${name}="${raw}" não é um número válido.`);
  }
  return value;
}

const ALERT_PERCENT = parseNumericEnv("ALERT_PERCENT", process.env.ALERT_PERCENT, 60);

let serviceAccount;
try {
  serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON);
} catch (err) {
  throw new Error(`FIREBASE_SERVICE_ACCOUNT_JSON não é um JSON válido: ${err.message}`);
}

if (!getApps().length) {
  initializeApp({
    credential: cert(serviceAccount),
    projectId: FIREBASE_PROJECT_ID,
  });
}

const db = getFirestore();

// ---------------------------------------------------------------------------
// Retry genérico com backoff exponencial
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Executa `fn` (uma função assíncrona) e tenta novamente em caso de falha,
 * com backoff exponencial. Usado para chamadas de rede (Telegram, WhatsApp,
 * Firestore) que podem falhar de forma transitória.
 */
async function withRetry(fn, { retries = 3, baseDelayMs = 1000, label = "operação" } = {}) {
  let lastError;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isLastAttempt = attempt === retries;
      console.warn(
        `⚠️ Tentativa ${attempt}/${retries} falhou para [${label}]: ${err.message}` +
          (isLastAttempt ? " — desistindo." : " — tentando novamente...")
      );
      if (!isLastAttempt) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        await sleep(delay);
      }
    }
  }

  throw new Error(`Falha definitiva em [${label}] após ${retries} tentativas: ${lastError.message}`);
}

// ---------------------------------------------------------------------------
// Helpers de formatação
// ---------------------------------------------------------------------------

function money(v) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(v) || 0);
}

function pct(v, digits = 2) {
  return `${Number(v || 0).toFixed(digits)}%`;
}

function monthId(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(monthNumber) {
  const labels = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];
  return labels[monthNumber - 1] || "";
}

function monthLabelFull(monthNumber) {
  const labels = [
    "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
    "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
  ];
  return labels[monthNumber - 1] || "";
}

function monthIdToFullLabel(id) {
  const [year, m] = id.split("-");
  return `${monthLabelFull(Number(m))} de ${year}`;
}

// ---------------------------------------------------------------------------
// Cálculo de dados de um mês
// ---------------------------------------------------------------------------

function calc(data = {}) {
  const salario = Number(data.salario || 0);
  const inter = Number(data.cartaoInter ?? data.inter ?? 0);
  const c6 = Number(data.cartaoC6 ?? data.c6 ?? 0);
  const seguro = Number(data.seguroCarro || 0);
  const saldoConta = Number(data.saldoConta || 0);

  const saidas = inter + c6 + seguro;
  const sobra = salario - saidas;
  const saldoFinal = saldoConta + sobra;
  const percentualSaidas = salario > 0 ? (saidas / salario) * 100 : 0;

  return {
    salario,
    inter,
    c6,
    seguro,
    saldoConta,
    saidas,
    sobra,
    saldoFinal,
    percentualSaidas,
  };
}

async function getMonth(uid, id) {
  const doc = await withRetry(() => db.doc(`users/${uid}/months/${id}`).get(), {
    label: `Firestore: leitura do mês ${id}`,
  });

  if (!doc.exists) {
    return { id, exists: false, raw: {}, ...calc({}) };
  }

  const data = doc.data() || {};
  return { id, exists: true, raw: data, ...calc(data) };
}

async function getYearMonths(uid, year) {
  const ids = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
  const refs = ids.map((id) => db.doc(`users/${uid}/months/${id}`));
  const snaps = await withRetry(() => db.getAll(...refs), {
    label: `Firestore: leitura em lote do ano ${year}`,
  });

  return ids.map((id, idx) => {
    const snap = snaps[idx];
    if (!snap.exists) {
      return { id, exists: false, raw: {}, ...calc({}) };
    }
    const data = snap.data() || {};
    return { id, exists: true, raw: data, ...calc(data) };
  });
}

/**
 * Lê users/{uid}/settings/report — preferências configuradas na tela
 * (card "Relatório Mensal"). Compatibilidade retroativa: se o documento
 * não existir, assume habilitado (comportamento antigo, antes dessa
 * integração existir). Se existir mas `enabled` for explicitamente
 * `false`, o relatório é pulado.
 */
async function getReportSettings(uid) {
  const snap = await withRetry(() => db.doc(`users/${uid}/settings/report`).get(), {
    label: "Firestore: leitura das configurações de relatório",
  });

  if (!snap.exists) {
    return { enabled: true, alertPct: null, notes: "" };
  }

  const data = snap.data() || {};
  return {
    enabled: data.enabled !== false,
    alertPct: typeof data.alertPct === "number" && Number.isFinite(data.alertPct) ? data.alertPct : null,
    notes: typeof data.notes === "string" ? data.notes.trim() : "",
  };
}

// ---------------------------------------------------------------------------
// Estatísticas do ano (média, melhor/pior mês, total economizado)
// ---------------------------------------------------------------------------

function computeYearStats(yearMonths, upToMonthId) {
  const closed = yearMonths.filter((m) => m.exists && m.id <= upToMonthId);

  if (closed.length === 0) {
    return {
      count: 0,
      avgSalario: 0,
      avgSaidas: 0,
      avgSobra: 0,
      avgPercentualSaidas: 0,
      totalEconomizadoAno: 0,
      melhorMes: null,
      piorMes: null,
    };
  }

  const sum = (fn) => closed.reduce((acc, m) => acc + fn(m), 0);
  const count = closed.length;

  const avgSalario = sum((m) => m.salario) / count;
  const avgSaidas = sum((m) => m.saidas) / count;
  const avgSobra = sum((m) => m.sobra) / count;
  const avgPercentualSaidas = sum((m) => m.percentualSaidas) / count;
  const totalEconomizadoAno = sum((m) => m.sobra);

  const melhorMes = closed.reduce((best, m) => (m.sobra > best.sobra ? m : best), closed[0]);
  const piorMes = closed.reduce((worst, m) => (m.sobra < worst.sobra ? m : worst), closed[0]);

  return {
    count,
    avgSalario,
    avgSaidas,
    avgSobra,
    avgPercentualSaidas,
    totalEconomizadoAno,
    melhorMes,
    piorMes,
  };
}

// Tendência com base nos últimos até-3 meses fechados (excluindo o mês atual)
function computeTrend(yearMonths, closedMonthId) {
  const closed = yearMonths.filter((m) => m.exists && m.id <= closedMonthId).sort((a, b) => (a.id < b.id ? -1 : 1));
  const lastThree = closed.slice(-3);

  if (lastThree.length < 2) {
    return { emoji: "➖", text: "Ainda não há histórico suficiente para indicar tendência." };
  }

  let up = 0;
  let down = 0;
  for (let i = 1; i < lastThree.length; i++) {
    if (lastThree[i].saidas > lastThree[i - 1].saidas) up++;
    else if (lastThree[i].saidas < lastThree[i - 1].saidas) down++;
  }

  if (up > down) {
    return { emoji: "📈", text: `Suas saídas vêm <b>subindo</b> nos últimos ${lastThree.length} meses.` };
  }
  if (down > up) {
    return { emoji: "📉", text: `Suas saídas vêm <b>caindo</b> nos últimos ${lastThree.length} meses.` };
  }
  return { emoji: "➡️", text: `Suas saídas estão <b>estáveis</b> nos últimos ${lastThree.length} meses.` };
}

// ---------------------------------------------------------------------------
// Telegram / WhatsApp
// ---------------------------------------------------------------------------

async function sendTelegramMessage(text) {
  await withRetry(
    async () => {
      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(`Telegram sendMessage error: ${JSON.stringify(data)}`);
      }
    },
    { label: "Telegram: sendMessage" }
  );
}

async function sendTelegramPhoto(photoPath, caption) {
  await withRetry(
    async () => {
      const form = new FormData();
      form.append("chat_id", TELEGRAM_CHAT_ID);
      form.append("caption", caption);
      form.append("parse_mode", "HTML");

      const fileBlob = new Blob([fs.readFileSync(photoPath)], { type: "image/png" });
      form.append("photo", fileBlob, path.basename(photoPath));

      const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
        method: "POST",
        body: form,
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(`Telegram sendPhoto error: ${JSON.stringify(data)}`);
      }
    },
    { label: `Telegram: sendPhoto (${path.basename(photoPath)})` }
  );
}

function htmlToWhatsApp(text) {
  return String(text)
    .replace(/<b>(.*?)<\/b>/g, "*$1*")
    .replace(/<\/?[^>]+(>|$)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function sendWhatsAppMessage(text) {
  if (!ZAPI_INSTANCE_ID || !ZAPI_TOKEN || !WHATSAPP_TO) {
    console.log("WhatsApp não configurado. Pulando envio por Z-API.");
    return;
  }

  const plainText = htmlToWhatsApp(text);
  const url = `https://api.z-api.io/instances/${ZAPI_INSTANCE_ID}/token/${ZAPI_TOKEN}/send-text`;

  const headers = { "Content-Type": "application/json" };
  if (ZAPI_CLIENT_TOKEN) headers["Client-Token"] = ZAPI_CLIENT_TOKEN;

  await withRetry(
    async () => {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          phone: String(WHATSAPP_TO).replace(/\D/g, ""),
          message: plainText,
        }),
      });

      const raw = await res.text();
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        data = { raw };
      }

      console.log("Z-API status:", res.status);
      console.log("Z-API resposta:", JSON.stringify(data));

      if (!res.ok) throw new Error(`Z-API send-text error: ${JSON.stringify(data)}`);
      if (data && data.success === false) throw new Error(`Z-API retornou falha: ${JSON.stringify(data)}`);
    },
    { label: "Z-API: send-text" }
  );
}

// ---------------------------------------------------------------------------
// Construção dos textos do relatório
// ---------------------------------------------------------------------------

function buildCategoryLine(label, value, totalSaidas, salario) {
  const shareOfSaidas = totalSaidas > 0 ? (value / totalSaidas) * 100 : 0;
  const shareOfSalario = salario > 0 ? (value / salario) * 100 : 0;
  return `• ${label}: <b>${money(value)}</b> (${pct(shareOfSaidas, 1)} das saídas · ${pct(shareOfSalario, 1)} do salário)`;
}

function buildCategoryComparisonLine(label, current, previous) {
  const diff = current - previous;
  if (Math.abs(diff) < 0.005) return `   ↳ igual ao mês anterior`;
  const arrow = diff > 0 ? "🔺" : "🔻";
  const pctChange = previous > 0 ? Math.abs((diff / previous) * 100) : 0;
  return `   ↳ ${arrow} ${money(Math.abs(diff))} (${pct(pctChange, 1)}) vs. mês anterior`;
}

function buildAlertText(month, alertPercent) {
  if (!month.exists) {
    return `⚠️ Não encontrei os dados de <b>${month.id}</b>.`;
  }
  if (month.percentualSaidas > alertPercent) {
    return `🚨 <b>Alerta:</b> suas saídas consumiram <b>${pct(month.percentualSaidas)}</b> do salário, acima do limite de <b>${alertPercent}%</b>.`;
  }
  return `✅ Suas saídas ficaram dentro do limite: <b>${pct(month.percentualSaidas)}</b> do salário (limite: ${alertPercent}%).`;
}

function buildComparisonText(currentMonth, previousMonth) {
  const diff = previousMonth.saidas - currentMonth.saidas;

  if (diff > 0) {
    const p = previousMonth.saidas > 0 ? ((diff / previousMonth.saidas) * 100).toFixed(2) : "0.00";
    return `✅ Você gastou <b>${money(diff)}</b> a menos que no mês anterior.\n📉 Redução de <b>${p}%</b>.`;
  }
  if (diff < 0) {
    const increase = Math.abs(diff);
    const p = previousMonth.saidas > 0 ? ((increase / previousMonth.saidas) * 100).toFixed(2) : "0.00";
    return `⚠️ Você gastou <b>${money(increase)}</b> a mais que no mês anterior.\n📈 Aumento de <b>${p}%</b>.`;
  }
  return `➖ Você gastou exatamente o mesmo valor que no mês anterior.`;
}

function buildQuickSummary(month) {
  if (!month.exists) {
    return `Sem dados para ${month.id}.`;
  }
  if (month.sobra < 0) {
    return `Suas saídas passaram <b>${money(Math.abs(month.sobra))}</b> do salário; seu saldo final projetado ficou em <b>${money(month.saldoFinal)}</b>.`;
  }
  return `Você terminou o mês com sobra de <b>${money(month.sobra)}</b> e saldo final projetado de <b>${money(month.saldoFinal)}</b>.`;
}

function buildFullReport({ closedMonth, previousMonth, yearStats, trend, year, alertPercent, notes }) {
  const header = `📊 <b>RELATÓRIO FINANCEIRO MENSAL</b>\n🗓 ${monthIdToFullLabel(closedMonth.id)}`;

  const receitaEGastos =
`💰 <b>Receita e Gastos</b>
• Salário: <b>${money(closedMonth.salario)}</b>
${buildCategoryLine("Cartão Inter", closedMonth.inter, closedMonth.saidas, closedMonth.salario)}
${buildCategoryComparisonLine("Inter", closedMonth.inter, previousMonth.inter)}
${buildCategoryLine("Cartão C6", closedMonth.c6, closedMonth.saidas, closedMonth.salario)}
${buildCategoryComparisonLine("C6", closedMonth.c6, previousMonth.c6)}
${buildCategoryLine("Seguro do carro", closedMonth.seguro, closedMonth.saidas, closedMonth.salario)}
${buildCategoryComparisonLine("Seguro", closedMonth.seguro, previousMonth.seguro)}
• <b>Total de saídas: ${money(closedMonth.saidas)}</b> (${pct(closedMonth.percentualSaidas)} do salário)
• Sobra do mês: <b>${money(closedMonth.sobra)}</b>
• Saldo final projetado: <b>${money(closedMonth.saldoFinal)}</b>`;

  const comparativo =
`🔄 <b>Comparativo com ${previousMonth.id}</b>
${buildComparisonText(closedMonth, previousMonth)}`;

  const mediaAno =
`📐 <b>Média de ${year} (até este mês, ${yearStats.count} meses fechados)</b>
• Salário médio: ${money(yearStats.avgSalario)}
• Saídas médias: ${money(yearStats.avgSaidas)} (${pct(yearStats.avgPercentualSaidas)} do salário)
• Sobra média: ${money(yearStats.avgSobra)}
• Total economizado no ano: <b>${money(yearStats.totalEconomizadoAno)}</b>`;

  const destaques = yearStats.melhorMes && yearStats.piorMes
    ? `🏆 <b>Destaques do ano</b>
• Melhor mês (maior sobra): ${monthIdToFullLabel(yearStats.melhorMes.id)} — ${money(yearStats.melhorMes.sobra)}
• Mês mais apertado (menor sobra): ${monthIdToFullLabel(yearStats.piorMes.id)} — ${money(yearStats.piorMes.sobra)}`
    : "";

  const tendencia = `${trend.emoji} <b>Tendência</b>\n${trend.text}`;

  const resumoRapido = `📝 <b>Resumo rápido</b>\n${buildQuickSummary(closedMonth)}`;

  const alerta = buildAlertText(closedMonth, alertPercent);

  const observacoes = notes ? `📌 <b>Observação</b>\n${notes}` : "";

  const avisos = [
    !closedMonth.exists ? `⚠️ Não encontrei o documento do mês <b>${closedMonth.id}</b>.` : "",
    !previousMonth.exists ? `⚠️ Não encontrei o documento do mês <b>${previousMonth.id}</b>.` : "",
  ].filter(Boolean).join("\n");

  return [
    header,
    receitaEGastos,
    comparativo,
    mediaAno,
    destaques,
    tendencia,
    resumoRapido,
    alerta,
    observacoes,
    avisos,
  ].filter(Boolean).join("\n\n").trim();
}

// ---------------------------------------------------------------------------
// Gráficos
// ---------------------------------------------------------------------------

async function generateYearChart(months, year) {
  const width = 1200;
  const height = 700;
  const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height, backgroundColour: "white" });

  const labels = months.map((m) => monthLabel(Number(m.id.split("-")[1])));
  const salarioData = months.map((m) => m.salario);
  const saidasData = months.map((m) => m.saidas);
  const saldoFinalData = months.map((m) => m.saldoFinal);

  const configuration = {
    type: "bar",
    data: {
      labels,
      datasets: [
        {
          type: "bar",
          label: "Salário",
          data: salarioData,
          backgroundColor: "rgba(54, 162, 235, 0.6)",
          borderColor: "rgba(54, 162, 235, 1)",
          borderWidth: 1,
        },
        {
          type: "bar",
          label: "Saídas (Inter + C6 + Seguro)",
          data: saidasData,
          backgroundColor: "rgba(255, 99, 132, 0.6)",
          borderColor: "rgba(255, 99, 132, 1)",
          borderWidth: 1,
        },
        {
          type: "line",
          label: "Saldo Final Projetado",
          data: saldoFinalData,
          borderColor: "rgba(255, 159, 64, 1)",
          backgroundColor: "rgba(255, 159, 64, 0.2)",
          borderWidth: 3,
          tension: 0.25,
          fill: false,
          yAxisID: "y",
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: { display: true, text: `Panorama financeiro de ${year}`, font: { size: 24 } },
        legend: { position: "bottom", labels: { font: { size: 16 } } },
      },
      scales: {
        x: { ticks: { font: { size: 14 } } },
        y: {
          ticks: {
            font: { size: 14 },
            callback: (value) =>
              new Intl.NumberFormat("pt-BR", {
                style: "currency",
                currency: "BRL",
                maximumFractionDigits: 0,
              }).format(value),
          },
        },
      },
    },
  };

  const buffer = await chartJSNodeCanvas.renderToBuffer(configuration);
  const outputPath = path.join(process.cwd(), `grafico-${year}.png`);
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

async function generateCategoryPieChart(month) {
  const width = 900;
  const height = 700;
  const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height, backgroundColour: "white" });

  const configuration = {
    type: "doughnut",
    data: {
      labels: ["Cartão Inter", "Cartão C6", "Seguro do carro"],
      datasets: [
        {
          data: [month.inter, month.c6, month.seguro],
          backgroundColor: [
            "rgba(54, 162, 235, 0.75)",
            "rgba(255, 206, 86, 0.75)",
            "rgba(153, 102, 255, 0.75)",
          ],
          borderColor: "white",
          borderWidth: 2,
        },
      ],
    },
    options: {
      responsive: false,
      plugins: {
        title: {
          display: true,
          text: `Composição das saídas — ${monthIdToFullLabel(month.id)}`,
          font: { size: 20 },
        },
        legend: { position: "bottom", labels: { font: { size: 16 } } },
      },
    },
  };

  const buffer = await chartJSNodeCanvas.renderToBuffer(configuration);
  const outputPath = path.join(process.cwd(), `composicao-${month.id}.png`);
  fs.writeFileSync(outputPath, buffer);
  return outputPath;
}

// ---------------------------------------------------------------------------
// Execução principal
// ---------------------------------------------------------------------------

async function main() {
  const now = new Date();

  const closedMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const previousMonthDate = new Date(now.getFullYear(), now.getMonth() - 2, 1);

  const closedMonthId = monthId(closedMonthDate);
  const previousMonthId = monthId(previousMonthDate);
  const year = closedMonthDate.getFullYear();

  // As quatro leituras são independentes entre si — rodam em paralelo em vez
  // de sequencialmente, o que reduz a latência total da execução.
  const [closedMonth, previousMonth, yearMonths, reportSettings] = await Promise.all([
    getMonth(REPORT_UID, closedMonthId),
    getMonth(REPORT_UID, previousMonthId),
    getYearMonths(REPORT_UID, year),
    getReportSettings(REPORT_UID),
  ]);

  // Respeita o toggle "Ativar relatório automático" configurado na tela.
  // Só é pulado se o documento existir E enabled for explicitamente false —
  // ausência do documento mantém o comportamento antigo (sempre envia).
  if (!reportSettings.enabled) {
    console.log(
      "Relatório desativado nas preferências do usuário (users/{uid}/settings/report.enabled = false). Nada foi enviado."
    );
    return;
  }

  // O limite configurado na tela tem prioridade sobre o env var ALERT_PERCENT;
  // o env var continua servindo de valor padrão para quem nunca configurou.
  const alertPercent = reportSettings.alertPct ?? ALERT_PERCENT;

  const yearStats = computeYearStats(yearMonths, closedMonthId);
  const trend = computeTrend(yearMonths, closedMonthId);

  const message = buildFullReport({
    closedMonth,
    previousMonth,
    yearStats,
    trend,
    year,
    alertPercent,
    notes: reportSettings.notes,
  });

  await sendTelegramMessage(message);

  try {
    await sendWhatsAppMessage(message);
  } catch (err) {
    console.error("Falha ao enviar no WhatsApp:", err.message);
  }

  const yearChartPath = await generateYearChart(yearMonths, year);
  await sendTelegramPhoto(
    yearChartPath,
    `📈 <b>Panorama de ${year}</b>\nSalário, saídas e saldo final projetado mês a mês.`
  );

  if (closedMonth.exists && closedMonth.saidas > 0) {
    const pieChartPath = await generateCategoryPieChart(closedMonth);
    await sendTelegramPhoto(
      pieChartPath,
      `🥧 <b>Composição das saídas de ${monthIdToFullLabel(closedMonth.id)}</b>`
    );
  }

  console.log("OK: relatório completo enviado no Telegram e tentativa de envio no WhatsApp concluída.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
