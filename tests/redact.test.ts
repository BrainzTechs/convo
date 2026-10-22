import { describe, expect, test } from 'claude-code/testing'
import { mask } from '../hooks/redact.ts'

const SECRETS = {
  anthropic: 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV',
  openaiProject: 'sk-proj-AbCdEf_GhIj-KlMnOpQrStUvWxYz0123456789',
  stripe: 'sk_live_51HabcdefGHIJKLmnop',
  awsTemp: 'ASIAABCDEFGHIJKLMNOP',
  githubPat: 'github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
  gitlab: 'glpat-abcdefghij1234567890',
  npm: 'npm_abcdefghijklmnopqrstuvwxyz0123456789',
  sendgrid: 'SG.abcdefghijklmnopqr.abcdefghijklmnopqrstuv',
  google: 'AIzaSyD-abcdefghijklmnopqrstuvwxyz12345',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijklmnop',
}

describe('redaction catches', () => {
  for (const [name, secret] of Object.entries(SECRETS)) {
    test(`${name} on its own and in text`, () => {
      expect(mask(`key ${secret} here`)).not.toContain(secret)
    })
  }
  test('passwords in connection strings, headers, Azure strings and webhooks', () => {
    expect(mask('postgres://app:Sup3rSecret@db:5432/x')).toBe('postgres://app:[REDACTED]@db:5432/x')
    expect(mask('curl -H "Authorization: Bearer abc.def-ghi_123"')).not.toContain('abc.def-ghi_123')
    expect(mask('Authorization: Basic dXNlcjpwYXNz')).not.toContain('dXNlcjpwYXNz')
    expect(mask('DefaultEndpointsProtocol=https;AccountName=a;AccountKey=abc123==;EndpointSuffix=x')).not.toContain('abc123==')
    expect(mask('https://hooks.slack.com/services/T000/B000/XXXXXXXX')).not.toContain('T000/B000')
  })
  test('secret-named keys in env files, JSON and YAML, quoted values whole', () => {
    expect(mask('AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).not.toContain('wJalrXUtnFEMI')
    expect(mask('DB_PASSWORD=hunter22')).toBe('DB_PASSWORD=[REDACTED]')
    expect(mask('DB_PASS=s3cr3t')).toBe('DB_PASS=[REDACTED]')
    expect(mask('redis://:mypassword@cache:6379')).toBe('redis://:[REDACTED]@cache:6379')
    expect(mask('{"password":"hunter2hunter2","api_key": "abcd1234"}')).toBe('{"password":"[REDACTED]","api_key": "[REDACTED]"}')
    expect(mask('password: "correct horse battery staple"')).toBe('password: "[REDACTED]"')
    expect(mask('GITHUB_TOKEN=abcdefghijklmnopqrstuvwxyz')).toBe('GITHUB_TOKEN=[REDACTED]')
  })
  test('a private key cut off before its END line', () => {
    expect(mask('here:\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabc')).toBe('here:\n[REDACTED]')
  })
})

describe('redaction leaves code and prose alone', () => {
  const same = [
    'const token = getToken(req);',
    'if (password === confirm) return',
    'function login(password: string, token: string) {}',
    'max_tokens: 4096',
    'The secret: we cache the results.',
    'token = process.env.API_TOKEN',
    'apiKey: config.apiKey',
    'password: undefined',
    'tokens = tokenize(text)',
    'apiKey = loadKeyFromVault(config)',
    'token = getToken2(req)',
    'token=${GITHUB_TOKEN_V2}',
  ]
  for (const s of same) test(JSON.stringify(s), () => expect(mask(s)).toBe(s))
})

describe('redaction stays fast', () => {
  test('long unbroken runs (base64, minified code, dotted names) take milliseconds', () => {
    for (const run of ['A'.repeat(1_000_000), 'a.'.repeat(500_000), `x${'-a'.repeat(300_000)}`, `https://${'a.'.repeat(100_000)}`]) {
      const t = Date.now()
      mask(run)
      expect(Date.now() - t).toBeLessThan(1500)
    }
  })
})
