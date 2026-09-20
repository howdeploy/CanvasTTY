import test from "node:test";
import assert from "node:assert/strict";
import {
  isPrivateIpv4,
  lanAddresses,
} from "../src/main/services/companion/LanNetwork.ts";
const entry = (address, internal = false) => ({
  address,
  internal,
  family: "IPv4",
  netmask: "255.255.255.0",
  mac: "00:00:00:00:00:00",
  cidr: address + "/24",
});
test("LAN discovery offers private addresses and prioritizes physical network interfaces", () => {
  const result = lanAddresses({
    utun4: [entry("10.8.0.2")],
    en1: [entry("192.168.2.100")],
    public: [entry("203.0.113.7")],
    lo0: [entry("127.0.0.1", true)],
    ipv6: [{ ...entry("fe80::1"), family: "IPv6" }],
  });
  assert.deepEqual(
    result.map((x) => x.address),
    ["192.168.2.100", "10.8.0.2"],
  );
  assert.deepEqual(lanAddresses({}), []);
});
test("the listener cannot be configured to a public, wildcard, loopback, or malformed address through discovery", () => {
  for (const ip of [
    "0.0.0.0",
    "127.0.0.1",
    "8.8.8.8",
    "100.64.0.1",
    "192.169.1.1",
    "172.32.0.1",
    "10.1.2.999",
    "192.168.1.2.attacker.test",
  ])
    assert.equal(isPrivateIpv4(ip), false, ip);
  for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.1.2"])
    assert.equal(isPrivateIpv4(ip), true, ip);
});

test('HTTPS origins are exact and never contain credentials or pairing data',async()=>{
  const {httpsOrigin}=await import('../src/main/services/companion/LanNetwork.ts');
  assert.equal(httpsOrigin(''), '');assert.equal(httpsOrigin('https://bridge.example.test/'),'https://bridge.example.test');
  for(const value of ['http://bridge.example.test','https://user:pass@bridge.example.test','https://bridge.example.test/g2/','https://bridge.example.test/?token=x','https://bridge.example.test/#pair=12345678','https://*.example.test'])assert.throws(()=>httpsOrigin(value));
});
