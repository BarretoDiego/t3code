import { assert, expect, it } from "@effect/vitest";
import {
  buildPairingUrl,
  formatHeadlessServeOutput,
  renderTerminalQrCode,
  resolveHeadlessConnectionString,
} from "./startupAccess.ts";

it("resolves wildcard hosts to a concrete external interface when one is available", () => {
  const connectionString = resolveHeadlessConnectionString("0.0.0.0", 3773, {
    en0: [
      {
        address: "192.168.1.42",
        netmask: "255.255.255.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "192.168.1.42/24",
      },
    ],
    lo0: [
      {
        address: "127.0.0.1",
        netmask: "255.0.0.0",
        family: "IPv4",
        mac: "00:00:00:00:00:00",
        internal: true,
        cidr: "127.0.0.1/8",
      },
    ],
  });

  expect(connectionString).toBe("http://192.168.1.42:3773");
});

it("builds a pairing URL that embeds the token in the hash", () => {
  expect(buildPairingUrl("http://192.168.1.42:3773", "PAIRCODE")).toBe(
    "http://192.168.1.42:3773/pair#token=PAIRCODE",
  );
});

it("renders terminal QR codes as a multi-line unicode block grid", () => {
  const qrCode = renderTerminalQrCode("http://192.168.1.42:3773/pair#token=PAIRCODE");

  assert.isTrue(qrCode.includes("█"));
  assert.isTrue(qrCode.split("\n").length > 10);
});

it("formats headless serve output with the connection string, token, pairing url, and qr code", () => {
  const output = formatHeadlessServeOutput({
    connectionString: "http://192.168.1.42:3773",
    token: "PAIRCODE",
    pairingUrl: "http://192.168.1.42:3773/pair#token=PAIRCODE",
  });

  expect(output).toContain("Connection string: http://192.168.1.42:3773");
  expect(output).toContain("Token: PAIRCODE");
  expect(output).toContain("Pairing URL: http://192.168.1.42:3773/pair#token=PAIRCODE");
  assert.isTrue(output.includes("█") || output.includes("▀") || output.includes("▄"));
});

const networkAddress = (address: string) => [
  {
    address,
    netmask: "255.255.255.0",
    family: "IPv4" as const,
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/24`,
  },
];

it("skips local VPN gateways and container networks when building a pairing URL", () => {
  const interfaces = {
    "nc-tun0": networkAddress("172.16.254.1"),
    utun0: networkAddress("172.16.254.1"),
    docker0: networkAddress("172.17.0.1"),
    br0: networkAddress("192.168.1.42"),
  };
  expect(resolveHeadlessConnectionString("0.0.0.0", 3774, interfaces)).toBe(
    "http://192.168.1.42:3774",
  );
  expect(resolveHeadlessConnectionString("172.16.254.1", 3774, interfaces)).toBe(
    "http://172.16.254.1:3774",
  );
});

it("does not fall back to a tunnel gateway when no LAN interface exists", () => {
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3774, {
      "nc-tun0": networkAddress("172.16.254.1"),
    }),
  ).toBe("http://localhost:3774");
});

it("keeps Tailscale's macOS tunnel usable for pairing", () => {
  expect(
    resolveHeadlessConnectionString("0.0.0.0", 3774, {
      utun4: [
        ...networkAddress("100.101.102.103"),
        {
          address: "fd7a:115c:a1e0::1",
          netmask: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
          family: "IPv6",
          mac: "00:00:00:00:00:00",
          internal: false,
          cidr: "fd7a:115c:a1e0::1/128",
          scopeid: 0,
        },
      ],
    }),
  ).toBe("http://100.101.102.103:3774");
});
