import { describe, expect, it } from 'vitest';
import { validateConfig } from '../src/config';

const route = { prefix: '/api', target: 'https://backend.example.test/api', hmacRequired: true };

describe('validateConfig', () => {
  it('accepts a valid config and defaults hmacRequired to false', () => {
    const { config, warnings } = validateConfig({ version: '1', routes: [{ prefix: '/', target: 'https://b.example.test' }] });
    expect(config.routes[0]!.hmacRequired).toBe(false);
    expect(warnings[0]).toMatch(/hmacRequired not set/);
  });

  it.each([
    ['null', null],
    ['no routes', { version: '1' }],
    ['routes not an array', { routes: {} }],
    ['prefix without slash', { routes: [{ ...route, prefix: 'api' }] }],
    ['http target', { routes: [{ ...route, target: 'http://backend.example.test' }] }],
    ['unparseable target', { routes: [{ ...route, target: 'not a url' }] }],
    ['missing target', { routes: [{ prefix: '/api' }] }]
  ])('rejects %s', (_name, raw) => {
    expect(() => validateConfig(raw)).toThrow(/Invalid config/);
  });

  it('warns, without failing, on duplicate prefixes and a bad rate limit', () => {
    const { warnings } = validateConfig({
      routes: [route, route],
      rateLimit: { enabled: true, requestsPerWindow: 0, windowSeconds: 60 }
    });
    expect(warnings.join('\n')).toMatch(/duplicate prefix \/api/);
    expect(warnings.join('\n')).toMatch(/rateLimit/);
  });
});
