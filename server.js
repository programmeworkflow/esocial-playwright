/**
 * eSocial Playwright Microservice
 *
 * Automates browser-based login to https://login.esocial.gov.br/
 * using an A1 digital certificate (.pfx) that is provided on each
 * request by the caller (the Medwork backend decrypts the PFX
 * from Supabase and forwards it here as base64).
 *
 * NOTHING is persisted on this service: certificates live only in
 * memory for the duration of a single HTTP request.
 */

const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 8080;
const VERSION = '2.4-stealth';

// ──────────────────────────────────────────────────────────────
// Small logger helper so every step is traceable in Render logs
// ──────────────────────────────────────────────────────────────
function log(requestId, step, detail) {
  const ts = new Date().toISOString();
  if (detail !== undefined) {
    console.log(`[${ts}] [${requestId}] ${step}:`, detail);
  } else {
    console.log(`[${ts}] [${requestId}] ${step}`);
  }
}

function newRequestId() {
  return Math.random().toString(36).slice(2, 10);
}

// ──────────────────────────────────────────────────────────────
// Browser / context helpers
// ──────────────────────────────────────────────────────────────

/**
 * Launches Chromium and creates an isolated context configured with
 * the caller-supplied PFX client certificate.
 *
 * The context is scoped to https://login.esocial.gov.br so the
 * certificate is auto-selected when that origin challenges for one.
 *
 * @param {Buffer} pfxBuffer   — decoded .pfx bytes
 * @param {string} password    — passphrase for the .pfx
 */
async function launchBrowserWithCert(pfxBuffer, password) {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  const context = await browser.newContext({
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
    javaScriptEnabled: true,
    // The gov.br SSO flow bounces through several hosts before the
    // client-cert handshake actually happens. If any one of them is
    // missing from this list the browser silently aborts the TLS
    // negotiation and the login fails. Cover every host the eSocial
    // / gov.br / Receita chain is known to use.
    clientCertificates: [
      { origin: 'https://login.esocial.gov.br', pfx: pfxBuffer, passphrase: password },
      { origin: 'https://www.esocial.gov.br',   pfx: pfxBuffer, passphrase: password },
      { origin: 'https://certificado.acesso.gov.br', pfx: pfxBuffer, passphrase: password },
      { origin: 'https://sso.acesso.gov.br',    pfx: pfxBuffer, passphrase: password },
      { origin: 'https://acesso.gov.br',        pfx: pfxBuffer, passphrase: password },
      { origin: 'https://cav.receita.fazenda.gov.br', pfx: pfxBuffer, passphrase: password },
      { origin: 'https://cert.acesso.gov.br',   pfx: pfxBuffer, passphrase: password },
      { origin: 'https://certificado.sso.acesso.gov.br', pfx: pfxBuffer, passphrase: password },
    ],
  });

  // Stealth: hide automation fingerprints that gov.br (or any bot
  // detection) can read via navigator.* to silently drop our clicks.
  await context.addInitScript(() => {
    // navigator.webdriver — dead giveaway of Playwright/Selenium
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // Plugins — real browsers have at least 1-3; headless Chromium has 0
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5].map(() => ({ name: 'Plugin', filename: '' })),
    });
    // Languages — sometimes probed
    Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en-US', 'en'] });
    // chrome object — headless doesn't have it
    if (!window.chrome) window.chrome = { runtime: {} };
    // Permissions — some checks probe notifications permission
    const origQuery = window.navigator.permissions?.query;
    if (origQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : origQuery(parameters);
    }
  });

  return { browser, context };
}

/**
 * Close browser/context gracefully — never throws.
 */
async function safeClose(browser, context) {
  try { if (context) await context.close(); } catch (_) {}
  try { if (browser) await browser.close(); } catch (_) {}
}

/**
 * Performs the full "Entrar com Certificado Digital" flow.
 * Returns an authenticated page, or throws with a Portuguese message.
 *
 * @param {import('playwright').BrowserContext} context
 * @param {string} requestId
 */
async function captureDebug(page) {
  const out = { url: null, title: null, bodyText: null, screenshot: null, htmlSnippet: null };
  try { out.url = page.url(); } catch (_) {}
  try { out.title = await page.title(); } catch (_) {}
  try { out.bodyText = (await page.locator('body').innerText({ timeout: 2_000 })).slice(0, 1_500); } catch (_) {}
  try {
    const shot = await page.screenshot({ fullPage: true, type: 'png' });
    out.screenshot = shot.toString('base64');
  } catch (_) {}
  try { out.htmlSnippet = (await page.content()).slice(0, 15_000); } catch (_) {}
  return out;
}

async function throwWithDebug(page, message) {
  const dbg = await captureDebug(page);
  const err = new Error(`${message} (url=${dbg.url}, title="${dbg.title}")`);
  err.debug = dbg;
  throw err;
}

async function doCertificateLogin(context, requestId) {
  const page = await context.newPage();
  page.setDefaultTimeout(60_000);

  // Trace every navigation so we can see exactly where the flow stops
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      log(requestId, 'frame_nav', frame.url());
    }
  });
  page.on('requestfailed', (req) => {
    log(requestId, 'request_failed', `${req.method()} ${req.url()} → ${req.failure()?.errorText}`);
  });

  log(requestId, 'navigating_login');
  await page.goto('https://login.esocial.gov.br/login.aspx', {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });

  // Step 1: the eSocial login page no longer exposes a "Certificado
  // Digital" option directly — it only has an "Entrar com gov.br"
  // button that redirects to sso.acesso.gov.br.
  log(requestId, 'clicking_gov_br_button');
  const govBrCandidates = [
    'a:has-text("Entrar com gov.br")',
    'button:has-text("Entrar com gov.br")',
    'text=Entrar com gov.br',
    'a:has-text("gov.br")',
    '[href*="acesso.gov.br"]',
  ];

  let govBrClicked = false;
  for (const sel of govBrCandidates) {
    const loc = page.locator(sel).first();
    if (await loc.count().catch(() => 0)) {
      try {
        await loc.click({ timeout: 5_000 });
        govBrClicked = true;
        log(requestId, 'gov_br_button_clicked_via', sel);
        break;
      } catch (_) { /* try next */ }
    }
  }
  if (!govBrClicked) {
    await throwWithDebug(page, 'Não foi possível localizar o botão "Entrar com gov.br" na página de login do eSocial');
  }

  // Step 2: wait for navigation to the gov.br SSO portal
  log(requestId, 'waiting_for_gov_br_sso');
  try {
    await page.waitForURL(
      (url) => /acesso\.gov\.br/.test(url.hostname),
      { timeout: 30_000 }
    );
    log(requestId, 'reached_gov_br_sso', page.url());
  } catch (_) {
    log(requestId, 'gov_br_sso_nav_timeout_url', page.url());
  }

  // Let gov.br's JS finish hydrating the login options.
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);

  // Step 3: locate and click the "Seu certificado digital" option.
  //
  // gov.br's HTML structure changes over time. We locate the element
  // by text ("Seu certificado digital", excluding "em nuvem"), walk up
  // to the nearest clickable (a/button/[role=button]/form ancestor),
  // wait for it to be enabled, then click and wait for navigation.
  log(requestId, 'locating_cert_option');

  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});

  // Dump button info for debugging
  const inventory = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    return all
      .map(el => ({
        tag: el.tagName,
        id: el.id || null,
        classes: el.className.slice(0, 80) || null,
        value: el.getAttribute('value') || null,
        text: (el.textContent || '').trim().slice(0, 60),
        disabled: el.hasAttribute('disabled'),
        formaction: el.getAttribute('formaction') || null,
      }))
      .filter(x => /certificad/i.test(x.text) || /certificad/i.test(x.value || '') || /certificad/i.test(x.formaction || ''));
  });
  log(requestId, 'cert_candidates', JSON.stringify(inventory).slice(0, 600));

  // Wait for the "certificate digital" option (not "em nuvem") to be present & enabled.
  try {
    await page.waitForFunction(() => {
      const all = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const match = all.find(el => {
        const t = (el.textContent || '').trim();
        return /Seu certificado digital\b(?! em nuvem)/i.test(t);
      });
      if (!match) return false;
      return !match.hasAttribute('disabled') && !match.classList.contains('loading');
    }, { timeout: 60_000, polling: 500 });
    log(requestId, 'cert_option_enabled');
  } catch (err) {
    log(requestId, 'cert_option_wait_timeout', err.message);
  }

  // Capture the URL *before* the click so we can detect navigation.
  const urlBefore = page.url();
  log(requestId, 'url_before_click', urlBefore);

  // Native Playwright click — generates `isTrusted: true` events via
  // Chrome DevTools Protocol, so gov.br's JS handlers (which often
  // check event trust) fire correctly. Text-based locator with exact
  // match of "Seu certificado digital" (excluding "em nuvem").
  const certLocator = page.locator('button, a, [role="button"]').filter({
    hasText: /^\s*Seu certificado digital\s*$/,
  }).first();

  if (!(await certLocator.count())) {
    await throwWithDebug(page, 'Locator "Seu certificado digital" (não "em nuvem") não resolveu no DOM');
  }

  // Strip disabled/loading + scroll into view.
  await certLocator.evaluate((el) => {
    el.removeAttribute('disabled');
    el.classList.remove('loading');
    el.scrollIntoView({ block: 'center' });
  });
  await page.waitForTimeout(500);

  // Use mouse.click at the element's real coordinates — this dispatches
  // pointerdown / mousedown / pointerup / mouseup / click in the exact
  // sequence a human produces. Some SPAs ignore naked .click() but
  // react to the full mouse-event sequence.
  const box = await certLocator.boundingBox();
  if (!box) {
    await throwWithDebug(page, 'BoundingBox do elemento "Seu certificado digital" não disponível');
  }
  log(requestId, 'cert_option_bbox', `x=${Math.round(box.x)} y=${Math.round(box.y)} w=${Math.round(box.width)} h=${Math.round(box.height)}`);

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.waitForTimeout(100);
  await page.mouse.click(cx, cy, { delay: 60 });
  log(requestId, 'mouse_click_dispatched');

  try {
    await page.waitForURL((url) => url.href !== urlBefore, { timeout: 30_000 });
    log(requestId, 'url_changed_after_click', page.url());
  } catch (err) {
    log(requestId, 'no_navigation_after_click', page.url());
  }

  // Browser picks the pre-configured client certificate automatically.
  // After the TLS handshake eSocial redirects to the empregador area.
  log(requestId, 'waiting_for_redirect_after_cert');
  try {
    await page.waitForURL(
      (url) => /esocial\.gov\.br/.test(url.hostname) && !/login\./.test(url.hostname),
      { timeout: 60_000 }
    );
  } catch (err) {
    const current = page.url();
    let title = null;
    let bodyText = null;
    let screenshot = null;
    let htmlSnippet = null;
    try { title = await page.title(); } catch (_) {}
    try { bodyText = (await page.locator('body').innerText({ timeout: 2_000 })).slice(0, 1_000); } catch (_) {}
    try {
      const shot = await page.screenshot({ fullPage: true, type: 'png' });
      screenshot = shot.toString('base64');
    } catch (_) {}
    try { htmlSnippet = (await page.content()).slice(0, 3_000); } catch (_) {}
    log(requestId, 'redirect_timeout_current_url', current);
    log(requestId, 'redirect_timeout_title', title);
    log(requestId, 'redirect_timeout_body_excerpt', bodyText);

    const e = new Error(
      `Falha no login com certificado digital em ${current}. ` +
      (title ? `Título: "${title}". ` : '') +
      'Verifique se o certificado é válido (ICP-Brasil, não vencido) e se a senha está correta.'
    );
    e.debug = { url: current, title, bodyText, screenshot, htmlSnippet };
    throw e;
  }

  log(requestId, 'login_succeeded_url', page.url());
  return page;
}

/**
 * Try to extract CNPJ / razão social from the landing page after login.
 * Best-effort only — the page markup is not part of a stable API.
 */
async function extractEmpregadorInfo(page, requestId) {
  const result = { cnpj: null, razaoSocial: null };

  try {
    // Many screens of eSocial show the selected empregador in the
    // header. We scan the whole page text once with a regex.
    const content = await page.content();

    const cnpjMatch = content.match(/(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})/);
    if (cnpjMatch) result.cnpj = cnpjMatch[1].replace(/\D/g, '');

    // Razão social usually appears right after "Empregador:" label.
    const razaoMatch = content.match(/Empregador[:\s]*<[^>]*>\s*([^<\n]{3,200})/i);
    if (razaoMatch) result.razaoSocial = razaoMatch[1].trim();
  } catch (err) {
    log(requestId, 'extract_info_failed', err.message);
  }

  return result;
}

// ──────────────────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'esocial-playwright', version: VERSION });
});

/**
 * POST /login-test
 * Body: { certificate: <base64 PFX>, password: string }
 */
app.post('/login-test', async (req, res) => {
  const requestId = newRequestId();
  const { certificate, password } = req.body || {};

  if (!certificate || !password) {
    return res.status(400).json({
      ok: false,
      error: 'Campos obrigatórios: certificate (base64) e password',
    });
  }

  let pfxBuffer;
  try {
    pfxBuffer = Buffer.from(certificate, 'base64');
    if (pfxBuffer.length < 100) throw new Error('buffer too small');
  } catch (_) {
    return res.status(400).json({ ok: false, error: 'Certificado base64 inválido' });
  }

  log(requestId, 'login_test_start', { certSize: pfxBuffer.length });

  let browser, context;
  try {
    ({ browser, context } = await launchBrowserWithCert(pfxBuffer, password));
    const page = await doCertificateLogin(context, requestId);
    const info = await extractEmpregadorInfo(page, requestId);

    log(requestId, 'login_test_done', info);
    return res.json({
      ok: true,
      loggedIn: true,
      cnpj: info.cnpj,
      razaoSocial: info.razaoSocial,
    });
  } catch (err) {
    log(requestId, 'login_test_error', err.message);
    return res.status(500).json({
      ok: false,
      loggedIn: false,
      error: err.message || 'Erro ao autenticar no eSocial',
      debug: err.debug || null,
    });
  } finally {
    await safeClose(browser, context);
    log(requestId, 'browser_closed');
  }
});

/**
 * Switches from the default profile to "Procurador de Pessoa Jurídica - CNPJ"
 * and enters the SST (Segurança e Saúde no Trabalho) module for the given CNPJ.
 *
 * After a successful call, the page is at https://frontend.esocial.gov.br/sst
 * with the empregador header showing the chosen CNPJ.
 */
async function switchToProcuradorPJ(page, cnpjDigits, requestId) {
  log(requestId, 'switching_to_procurador_pj', { cnpj: cnpjDigits });

  await page.goto('https://www.esocial.gov.br/portal/Home/Index?trocarPerfil=true', {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(1500);

  const perfilSelect = page.locator('select').filter({ hasText: /Titular|Procurador/ }).first();
  if (!(await perfilSelect.count())) {
    await throwWithDebug(page, 'Dropdown "Selecione o seu perfil" não encontrado');
  }
  await perfilSelect.selectOption({ label: 'Procurador de Pessoa Jurídica - CNPJ' });
  log(requestId, 'perfil_procurador_pj_selected');
  await page.waitForTimeout(1000);

  let cnpjInput = page.getByLabel(/Informe o CNPJ representado/i).first();
  if (!(await cnpjInput.count())) {
    cnpjInput = page.locator('label:has-text("CNPJ representado") + input, label:has-text("CNPJ") ~ input').first();
  }
  if (!(await cnpjInput.count())) {
    cnpjInput = page.locator('input[type="text"]:visible').filter({ hasNot: page.locator('[readonly]') }).first();
  }
  if (!(await cnpjInput.count())) {
    await throwWithDebug(page, 'Campo de CNPJ representado não apareceu após escolher Procurador PJ');
  }
  const cnpjFormatted = `${cnpjDigits.slice(0,2)}.${cnpjDigits.slice(2,5)}.${cnpjDigits.slice(5,8)}/${cnpjDigits.slice(8,12)}-${cnpjDigits.slice(12,14)}`;
  await cnpjInput.fill(cnpjFormatted);
  log(requestId, 'cnpj_filled', cnpjFormatted);

  const verificarBtn = page.locator('button, input[type="submit"], input[type="button"]').filter({ hasText: /^Verificar$/i }).first();
  await verificarBtn.click();
  log(requestId, 'verificar_clicked');
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2500);

  const bodyText = await page.locator('body').innerText().catch(() => '');
  if (/não.*encontrad|inválid|sem permiss|sem procura|não autoriz/i.test(bodyText)) {
    await throwWithDebug(page, `CNPJ ${cnpjFormatted} não autorizado via procuração ou inválido`);
  }

  const sstModule = page.locator('a, button, div').filter({ hasText: /^Segurança e Saúde no Trabalho$/ }).first();
  if (!(await sstModule.count())) {
    const anySst = page.locator('text=/Segurança.*Saúde.*Trabalho/i').first();
    if (!(await anySst.count())) {
      await throwWithDebug(page, 'Módulo SST não disponível para esse CNPJ. Procuração pode não incluir SST.');
    }
    await anySst.click();
  } else {
    await sstModule.click();
  }
  log(requestId, 'sst_module_clicked');

  await page.waitForURL((url) => /frontend\.esocial\.gov\.br\/sst/.test(url.href), { timeout: 45_000 })
    .catch(async () => {
      await throwWithDebug(page, 'Não redirecionou para frontend.esocial.gov.br/sst após clicar em SST');
    });
  await page.waitForLoadState('networkidle').catch(() => {});
  log(requestId, 'on_sst_frontend', page.url());
}

/**
 * On /sst/gestaoTrabalhadores extracts the list of trabalhadores.
 * Two modes are possible:
 *   - "lista" mode (small companies): all workers are displayed in blocks
 *   - "cpf" mode (large companies): only a CPF input is shown; the caller
 *     must supply a list of CPFs and we query one by one.
 *
 * If `cpfList` is provided, forces CPF-by-CPF mode regardless of what the
 * page shows initially.
 */
async function scrapeGestaoTrabalhadores(page, requestId, cpfList = null) {
  log(requestId, 'navigating_to_gestao_trabalhadores');
  await page.goto('https://frontend.esocial.gov.br/sst/gestaoTrabalhadores', {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2500);

  const pageText = await page.locator('body').innerText().catch(() => '');

  if (/Não há empregado.*para exibi/i.test(pageText)) {
    log(requestId, 'empty_company');
    return { mode: 'empty', trabalhadores: [] };
  }

  const listaHeader = await page.locator('text=/Lista de Trabalhadores/i').count();
  const cpfInput = page.locator('input[placeholder*="CPF" i], input[id*="cpf" i], input[name*="cpf" i]').first();
  const hasCpfInput = await cpfInput.count();

  if (listaHeader > 0 && (!cpfList || cpfList.length === 0)) {
    log(requestId, 'extracting_bloco_list');
    const trabalhadores = await page.evaluate(() => {
      const cpfRegex = /(\d{3}\.\d{3}\.\d{3}-\d{2})/;
      const uniq = new Map();
      const allBlocks = Array.from(document.querySelectorAll('div, article, section, li'));
      for (const block of allBlocks) {
        const txt = (block.innerText || '').trim();
        if (!txt) continue;
        const cpfMatch = txt.match(cpfRegex);
        if (!cpfMatch) continue;
        if (block.querySelectorAll('div,article,section,li').length > 3) continue;
        const lines = txt.split('\n').map(l => l.trim()).filter(Boolean);
        const nomeLine = lines.find(l => !cpfRegex.test(l) && l.length > 3 && l.length < 100);
        const cpf = cpfMatch[1].replace(/\D/g, '');
        if (!uniq.has(cpf) && nomeLine) {
          uniq.set(cpf, { nome: nomeLine, cpf, situacao: 'ativo' });
        }
      }
      return Array.from(uniq.values());
    });
    log(requestId, 'bloco_list_extracted', { total: trabalhadores.length });
    return { mode: 'lista', trabalhadores };
  }

  if (hasCpfInput && cpfList && cpfList.length > 0) {
    log(requestId, 'querying_by_cpf', { total: cpfList.length });
    const trabalhadores = [];
    for (const cpfRaw of cpfList) {
      const cpf = String(cpfRaw).replace(/\D/g, '');
      if (cpf.length !== 11) continue;
      try {
        await cpfInput.fill('');
        await cpfInput.fill(cpf);
        await cpfInput.press('Enter');
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(1200);

        const result = await page.evaluate((cpf) => {
          const body = document.body.innerText || '';
          const notFound = /não (foi |)encontrad|sem registro|não há dados/i.test(body);
          if (notFound) return { cpf, situacao: 'nao_encontrado', nome: null };
          const nameMatch = body.match(/([A-ZÁ-Ú][A-Za-zÀ-ÿ' ]+[A-Za-zÀ-ÿ])(?=\s*\n|\s*\d{3}\.\d{3}\.\d{3})/);
          const situacaoMatch = body.match(/Situa[cç][aã]o[:\s]+(\w+)/i);
          return {
            cpf,
            nome: nameMatch ? nameMatch[1].trim() : null,
            situacao: situacaoMatch ? situacaoMatch[1].toLowerCase() : 'ativo',
          };
        }, cpf);
        trabalhadores.push(result);
      } catch (err) {
        trabalhadores.push({ cpf, situacao: 'erro', error: err.message.slice(0, 150) });
      }
    }
    return { mode: 'cpf-a-cpf', trabalhadores };
  }

  if (hasCpfInput && (!cpfList || cpfList.length === 0)) {
    return {
      mode: 'cpf-input-required',
      trabalhadores: [],
      notice: 'Empresa não lista trabalhadores automaticamente. Forneça cpfList no body da requisição.',
    };
  }

  await throwWithDebug(page, 'Página /sst/gestaoTrabalhadores em estado inesperado');
}

/**
 * POST /fetch-funcionarios
 * Body: { certificate, password, cnpj, cpfList? }
 *
 * - `cpfList` é opcional. Sem ela, o serviço tenta extrair a lista em blocos
 *   (modo "empresa pequena"). Se o portal não listar automaticamente,
 *   retorna mode='cpf-input-required' indicando que precisa de uma lista.
 * - Com `cpfList`, consulta CPF a CPF e retorna situação de cada um.
 */
app.post('/fetch-funcionarios', async (req, res) => {
  const requestId = newRequestId();
  const { certificate, password, cnpj, cpfList } = req.body || {};

  if (!certificate || !password || !cnpj) {
    return res.status(400).json({
      ok: false,
      error: 'Campos obrigatórios: certificate, password e cnpj',
    });
  }

  const cleanCnpj = String(cnpj).replace(/\D/g, '');
  if (cleanCnpj.length !== 14) {
    return res.status(400).json({ ok: false, error: 'CNPJ inválido (precisa ter 14 dígitos)' });
  }

  let pfxBuffer;
  try {
    pfxBuffer = Buffer.from(certificate, 'base64');
    if (pfxBuffer.length < 100) throw new Error('buffer too small');
  } catch (_) {
    return res.status(400).json({ ok: false, error: 'Certificado base64 inválido' });
  }

  log(requestId, 'fetch_funcionarios_start', { cnpj: cleanCnpj, cpfListCount: cpfList?.length || 0 });

  let browser, context;
  try {
    ({ browser, context } = await launchBrowserWithCert(pfxBuffer, password));

    const page = await doCertificateLogin(context, requestId);
    page.setDefaultTimeout(90_000);

    await switchToProcuradorPJ(page, cleanCnpj, requestId);
    const result = await scrapeGestaoTrabalhadores(page, requestId, cpfList || null);

    log(requestId, 'fetch_funcionarios_done', { mode: result.mode, total: result.trabalhadores.length });

    return res.json({
      ok: true,
      cnpj: cleanCnpj,
      mode: result.mode,
      funcionarios: result.trabalhadores,
      notice: result.notice || null,
    });
  } catch (err) {
    log(requestId, 'fetch_funcionarios_error', err.message);
    return res.status(500).json({
      ok: false,
      error: err.message || 'Erro ao buscar funcionários',
      debug: err.debug || null,
    });
  } finally {
    await safeClose(browser, context);
    log(requestId, 'browser_closed');
  }
});

// ──────────────────────────────────────────────────────────────
// 404 + error handler
// ──────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ ok: false, error: `Rota não encontrada: ${req.method} ${req.path}` });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[UNHANDLED]', err);
  res.status(500).json({ ok: false, error: err.message || 'Erro interno' });
});

app.listen(PORT, () => {
  console.log(`eSocial Playwright service listening on :${PORT} (v${VERSION})`);
});
