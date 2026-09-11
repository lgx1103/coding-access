import { expect, test } from 'vitest';
import { serviceBaseUrl } from '../src/shared/service-url.js';

test('company service accepts HTTP internal IPs and DNS names as well as HTTPS', () => {
  for (const [input, expected] of [
    ['http://10.20.30.40:4317/', 'http://10.20.30.40:4317'],
    ['http://coding.company.internal:8080', 'http://coding.company.internal:8080'],
    ['http://[fd00::1234]:4317', 'http://[fd00::1234]:4317'],
    ['http://127.0.0.1:4317', 'http://127.0.0.1:4317'],
    [' https://coding.company.test/ ', 'https://coding.company.test'],
  ]) expect(serviceBaseUrl(input)).toBe(expected);
});

test('company service rejects non-web schemes, embedded credentials and endpoint paths', () => {
  for (const input of ['', null, 123, '10.20.30.40:4317', 'file:///tmp/config', 'javascript:alert(1)', 'ftp://company.test', 'http://user:password@company.test', 'http://company.test/v1', 'http://company.test/?key=value', 'http://company.test/#fragment', `http://${'a'.repeat(2048)}.test`]) {
    expect(() => serviceBaseUrl(input)).toThrow();
  }
});
