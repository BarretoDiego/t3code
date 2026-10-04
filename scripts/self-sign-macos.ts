// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - electron-builder calls this hook as a plain async function, outside any Effect runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { sign as signApplication } from "@electron/osx-sign";

interface AfterPackContext {
  readonly appOutDir: string;
  readonly electronPlatformName: string;
  readonly packager: { readonly appInfo: { readonly productFilename: string } };
}

const security = (...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("security", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/**
 * electron-builder `afterPack` hook for builds without an Apple Developer ID.
 * Signs the app with the self-signed certificate in
 * T3CODE_DESKTOP_MAC_SELF_SIGN_P12 (base64 PKCS#12, password in
 * T3CODE_DESKTOP_MAC_SELF_SIGN_PASSWORD). Squirrel.Mac only installs an update
 * that satisfies the running app's designated requirement. An ad hoc signature
 * pins that to one build's hash, while a certificate that stays the same across
 * builds lets every later build satisfy it. Gatekeeper still treats the app as
 * unidentified, so the first install is done by hand.
 */
export default async function selfSignMacApp(context: AfterPackContext): Promise<void> {
  if (context.electronPlatformName !== "darwin") return;
  const p12 = process.env.T3CODE_DESKTOP_MAC_SELF_SIGN_P12?.trim();
  if (!p12) return;

  const appPath = NodePath.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-self-sign-"));
  const keychain = NodePath.join(workDir, "signing.keychain-db");
  const keychainPassword = NodeCrypto.randomBytes(16).toString("hex");
  const certPath = NodePath.join(workDir, "signing.p12");
  let keychainCreated = false;
  let previousSearchList: ReadonlyArray<string> | undefined;

  try {
    NodeFS.writeFileSync(certPath, Buffer.from(p12, "base64"), { mode: 0o600 });
    security("create-keychain", "-p", keychainPassword, keychain);
    keychainCreated = true;
    security("set-keychain-settings", "-lut", "21600", keychain);
    security("unlock-keychain", "-p", keychainPassword, keychain);
    security(
      "import",
      certPath,
      "-k",
      keychain,
      "-P",
      process.env.T3CODE_DESKTOP_MAC_SELF_SIGN_PASSWORD ?? "",
      "-T",
      "/usr/bin/codesign",
    );
    security(
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:",
      "-s",
      "-k",
      keychainPassword,
      keychain,
    );

    // codesign only resolves an identity from keychains on the user search
    // list, even when one is named with --keychain.
    previousSearchList = [...security("list-keychains", "-d", "user").matchAll(/"([^"]+)"/g)].map(
      (match) => match[1]!,
    );
    security("list-keychains", "-d", "user", "-s", keychain, ...previousSearchList);

    // A self-signed certificate is untrusted, so it is absent from the "valid"
    // list and has to be addressed by hash with identity validation off.
    const identity = /\b([0-9A-F]{40})\b/.exec(
      security("find-identity", "-p", "codesigning", keychain),
    )?.[1];
    if (!identity) {
      throw new Error("T3CODE_DESKTOP_MAC_SELF_SIGN_P12 holds no code signing identity.");
    }

    await signApplication({
      app: appPath,
      identity,
      keychain,
      identityValidation: false,
      preAutoEntitlements: false,
      batchCodesignCalls: true,
      optionsForFile: () => ({ hardenedRuntime: false, timestamp: "none" }),
    });
    NodeChildProcess.execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
      stdio: "inherit",
    });
    console.log(`[self-sign-macos] Signed ${appPath} with self-signed identity ${identity}.`);
  } finally {
    if (previousSearchList) {
      security("list-keychains", "-d", "user", "-s", ...previousSearchList);
    }
    if (keychainCreated) {
      try {
        security("delete-keychain", keychain);
      } catch {
        // The temp directory removal below takes the keychain file with it.
      }
    }
    NodeFS.rmSync(workDir, { recursive: true, force: true });
  }
}
