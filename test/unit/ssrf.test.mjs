import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicHttpUrl, isPrivateIp } from '../../server/import/ssrf.mjs';

const privateAddresses = [
  '', 'not-an-ip', '0.0.0.0', '10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
  '100.64.0.1', '192.0.0.8', '192.168.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
  '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fe80::1%eth0', 'fec0::1', 'ff02::1', '2001:db8::1',
  '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '::ffff:169.254.169.254',
  // Previously treated as public (M7 finding):
  '::7f00:1', '::127.0.0.1', '64:ff9b::a9fe:a9fe', '64:ff9b::10.0.0.1', '2002:7f00:1::1', '2002:c0a8:101::'
];
const publicAddresses = [
  '8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '192.0.1.1',
  '198.20.0.1', '223.255.255.255', '2606:4700:4700::1111', '2400:3200::1', '::ffff:8.8.8.8',
  '64:ff9b::808:808', '2002:808:808::1'
];

test('isPrivateIp blocks loopback, private, link-local, CGNAT, multicast and reserved ranges', () => {
  for (const address of privateAddresses) assert.equal(isPrivateIp(address), true, address);
});

test('isPrivateIp allows public IPv4/IPv6 (including mapped / NAT64 / 6to4 forms of public IPv4)', () => {
  for (const address of publicAddresses) assert.equal(isPrivateIp(address), false, address);
});

test('assertPublicHttpUrl rejects unsupported schemes, credentials and private literals without DNS', async () => {
  const rejects = async (url, code) => {
    await assert.rejects(assertPublicHttpUrl(url), (error) => error.code === code, url);
  };
  await rejects('not a url', 'BAD_SOURCE_URL');
  await rejects('file:///etc/passwd', 'UNSUPPORTED_URL_PROTOCOL');
  await rejects('ftp://example.com/', 'UNSUPPORTED_URL_PROTOCOL');
  await rejects('http://user:pass@8.8.8.8/', 'UNSAFE_SOURCE_URL');
  for (const host of ['127.0.0.1', '[::1]', '[::ffff:7f00:1]', '[::7f00:1]', '169.254.169.254', '[64:ff9b::a9fe:a9fe]', '0x7f.1', '2130706433']) {
    await rejects(`http://${host}/`, 'UNSAFE_SOURCE_URL');
  }
});

test('assertPublicHttpUrl accepts a public IP literal', async () => {
  const url = await assertPublicHttpUrl('https://8.8.8.8/path?q=1');
  assert.equal(url.hostname, '8.8.8.8');
});
