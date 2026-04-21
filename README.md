# eSocial Playwright Microservice

Microservice that automates browser-based login to the eSocial portal
(https://login.esocial.gov.br/) using an A1 digital certificate (.pfx)
supplied by the caller on every request. No certificate is ever
persisted on this service.

## Endpoints

### `GET /health`
Liveness probe.
```json
{ "ok": true, "service": "esocial-playwright", "version": "1.0" }
```

### `POST /login-test`
Verifies that a certificate can log in to eSocial.

Body:
```json
{
  "certificate": "<base64 PFX>",
  "password": "<pfx password>"
}
```

Response:
```json
{
  "ok": true,
  "loggedIn": true,
  "cnpj": "12345678000199",
  "razaoSocial": "EMPRESA LTDA"
}
```

### `POST /fetch-funcionarios`
Fetches active/dismissed employees for a given CNPJ.

Body:
```json
{
  "certificate": "<base64 PFX>",
  "password": "<pfx password>",
  "cnpj": "12345678000199"
}
```

> **NOTE:** the navigation inside the empregador portal for listing
> employees is still a TODO — the endpoint currently returns an empty
> list with a `notice` string once login succeeds.

## Local run

```bash
npm install
npx playwright install chromium
npm start
```

## Docker / Render

The service is designed to run on `mcr.microsoft.com/playwright:v1.50.0-jammy`
which has Chromium and its system deps pre-installed. Use the **starter**
plan on Render — the free tier OOMs on Chromium.
