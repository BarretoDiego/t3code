import { isTailnetHost } from "./hostClassification.ts";

type NetworkAddress = { readonly family: string | number; readonly address: string };

/** macOS shares utun names across VPNs; Tailscale's IPv6 range identifies its tunnel. */
export const isTailscaleNetworkInterface = (
  name: string,
  entries: ReadonlyArray<NetworkAddress>,
): boolean =>
  /^tailscale/i.test(name) ||
  entries.some(
    (entry) => (entry.family === "IPv6" || entry.family === 6) && isTailnetHost(entry.address),
  );

// Host bridges such as br0 and Proxmox's vmbr0 carry the real LAN address.
const VIRTUAL_INTERFACE =
  /^(docker|br-|veth|virbr|vmnet|vboxnet|vEthernet \((?:WSL|Default Switch)|podman|cni|flannel|cali|lxcbr|lxdbr|bridge[1-9]\d\d)/;
const TUNNEL_INTERFACE = /^(utun|tun|tap|ipsec|ppp|wg)\d*$|(?:^|[-_])(tun|tap)\d*$/i;

/**
 * Local container networks and VPN packet gateways are not routes to this host
 * from another device. Keep Tailscale's peer address, including on macOS utun.
 */
export const isHostOnlyNetworkInterface = (
  name: string,
  entries: ReadonlyArray<NetworkAddress>,
): boolean =>
  !isTailscaleNetworkInterface(name, entries) &&
  (VIRTUAL_INTERFACE.test(name) || TUNNEL_INTERFACE.test(name));
