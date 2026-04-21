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
const VERSION = '1.7-precise-click';

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
    ],
  });

  const context = await browser.newContext({
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
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

  // Step 3: click "Seu certificado digital" in the gov.br SSO page.
  // getByText with exact:true matches only leaf nodes whose full text
  // equals the string, so it won't accidentally pick the "em nuvem"
  // variant or a wrapping <div> that contains both.
  log(requestId, 'clicking_seu_certificado_digital');
  let certClicked = false;

  // 1) Try the safest: exact-text match
  try {
    const loc = page.getByText('Seu certificado digital', { exact: true }).first();
    if (await loc.count() > 0) {
      await loc.click({ timeout: 8_000 });
      certClicked = true;
      log(requestId, 'cert_clicked_via', 'getByText exact');
    }
  } catch (e) { log(requestId, 'getByText_attempt_failed', e.message); }

  // 2) Fallback: target visible span/label/a leaves that contain the
  //    exact phrase but not "em nuvem"
  if (!certClicked) {
    const leafSelectors = [
      'span:text-is("Seu certificado digital")',
      'a:text-is("Seu certificado digital")',
      'button:text-is("Seu certificado digital")',
      'div:text-is("Seu certificado digital")',
      'label:text-is("Seu certificado digital")',
    ];
    for (const sel of leafSelectors) {
      try {
        const loc = page.locator(sel).first();
        if (await loc.count() > 0) {
          await loc.click({ timeout: 8_000 });
          certClicked = true;
          log(requestId, 'cert_clicked_via', sel);
          break;
        }
      } catch (e) { log(requestId, 'leaf_selector_failed', `${sel}: ${e.message}`); }
    }
  }

  // 3) Last resort: enumerate all elements with the phrase and click the
  //    first one whose own text equals exactly "Seu certificado digital".
  if (!certClicked) {
    const clickedViaJs = await page.evaluate(() => {
      const target = 'Seu certificado digital';
      const all = Array.from(document.querySelectorAll('*'));
      for (const el of all) {
        const ownText = Array.from(el.childNodes)
          .filter(n => n.nodeType === 3)
          .map(n => n.textContent.trim())
          .filter(Boolean)
          .join(' ');
        if (ownText === target) {
          // climb up to the first clickable ancestor (a, button, [role=button], [onclick])
          let anchor = el;
          while (anchor && !(
            anchor.tagName === 'A' ||
            anchor.tagName === 'BUTTON' ||
            anchor.getAttribute('role') === 'button' ||
            anchor.hasAttribute('onclick')
          )) anchor = anchor.parentElement;
          (anchor || el).click();
          return (anchor || el).outerHTML.slice(0, 300);
        }
      }
      return null;
    });
    if (clickedViaJs) {
      certClicked = true;
      log(requestId, 'cert_clicked_via_js', clickedViaJs);
    }
  }

  if (!certClicked) {
    await throwWithDebug(page, 'Não foi possível clicar em "Seu certificado digital" no portal gov.br');
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
 * POST /fetch-funcionarios
 * Body: { certificate, password, cnpj }
 *
 * TODO: The exact navigation path inside the empregador portal to
 * list active/dismissed employees still needs to be mapped by the
 * user (menu path + DOM selectors). For now this endpoint performs
 * the login, verifies we reached the empregador area, and returns
 * an empty list with a notice.
 */
app.post('/fetch-funcionarios', async (req, res) => {
  const requestId = newRequestId();
  const { certificate, password, cnpj } = req.body || {};

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

  log(requestId, 'fetch_funcionarios_start', { cnpj: cleanCnpj });

  let browser, context;
  try {
    ({ browser, context } = await launchBrowserWithCert(pfxBuffer, password));

    // Give data-fetch more headroom than login-only
    const page = await doCertificateLogin(context, requestId);
    page.setDefaultTimeout(90_000);

    // ────────────────────────────────────────────────────────
    // TODO: implement empresa selection + funcionarios scrape.
    //
    // Expected steps (to be confirmed by user against real portal):
    //   1. On the empregador home, click "Selecionar Empregador"
    //      (or similar) and search by CNPJ = cleanCnpj.
    //   2. Navigate to: Trabalhador → Consultar Trabalhadores
    //      (exact menu labels may differ).
    //   3. Toggle filters to show BOTH active and dismissed.
    //   4. Paginate through the results table, extracting:
    //        cpf, nome, matricula, dataAdmissao, situacao,
    //        dataDesligamento (if desligado), cargo.
    //
    // Until that UI map is nailed down we return an empty list so
    // callers can exercise the pipeline end-to-end.
    // ────────────────────────────────────────────────────────
    log(requestId, 'funcionarios_fetch_not_yet_implemented');

    return res.json({
      ok: true,
      funcionarios: [],
      notice:
        'Login efetuado com sucesso, mas a extração de funcionários ainda ' +
        'não foi mapeada. Forneça o caminho exato (menus + seletores) da ' +
        'listagem no portal eSocial para finalizar a implementação.',
      cnpj: cleanCnpj,
    });
  } catch (err) {
    log(requestId, 'fetch_funcionarios_error', err.message);
    return res.status(500).json({
      ok: false,
      error: err.message || 'Erro ao buscar funcionários',
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
