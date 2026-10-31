// The Pi's WebAuthn page (design B). It only signs: the receiver checks every step.
"use strict";
const BOX = "pi"; // pinned here, never taken from a reply
const RP_ID = location.hostname;
const WORDS = {
  "probe": "check the wiring (nothing happens)",
  "defib-fire": "power-cycle TrueNAS (it still won't if TrueNAS answers)",
  "kill-arm": "arm the kill switch",
  "kill-off": "disarm the kill switch",
  "kill-on": "LOCK the Pi (Tang goes down; recovery is at the console)",
};
const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();

function b64url(buf) {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64(buf) {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}
function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function say(text, cls) {
  const st = $("status");
  st.textContent = text;
  st.className = cls || "";
}
function busy(on) {
  for (const b of document.querySelectorAll("button")) b.disabled = on;
}

async function sign(action, step, nonce) {
  const bytes = enc.encode(`app-commands/v1\n${BOX}\n${action}\n${step}\n${nonce}`);
  const challenge = await crypto.subtle.digest("SHA-256", bytes);
  const cred = await navigator.credentials.get({
    publicKey: { challenge, rpId: RP_ID, userVerification: "required", timeout: 60000 },
  });
  const r = cred.response;
  return {
    credentialId: b64url(cred.rawId),
    authenticatorData: b64url(r.authenticatorData),
    clientDataJSON: b64url(r.clientDataJSON),
    sig: b64(r.signature),
  };
}

async function post(path, body) {
  const res = await fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store",
  });
  let out;
  try { out = await res.json(); } catch (e) { out = { result: `refused: HTTP ${res.status} (${e.message})` }; }
  return out;
}

let pending = null; // {action, n2}

async function ask(action) {
  busy(true);
  try {
    say(`Asking the Pi to ${WORDS[action]}. Unlock your key.`);
    const n1 = hex(crypto.getRandomValues(new Uint8Array(32)));
    const out = await post("/request", { action, n1, ...(await sign(action, "request", n1)) });
    if (out.result !== "pending" || !out.n2) {
      say(out.result, "bad");
      return;
    }
    pending = { action, n2: out.n2 };
    $("confirm-q").textContent = `pi: ${WORDS[action]}. Confirm?`;
    $("actions").style.display = "none";
    $("confirm").style.display = "block";
    say("The Pi is waiting 90 seconds for your answer.");
  } catch (e) {
    say(`Not sent: ${e.name}: ${e.message}`, "bad");
  } finally {
    busy(false);
  }
}

function reset() {
  pending = null;
  $("confirm").style.display = "none";
  $("actions").style.display = "block";
}

async function confirmIt() {
  if (!pending) return;
  const { action, n2 } = pending;
  busy(true);
  try {
    say("Unlock your key again to confirm.");
    const out = await post("/confirm", { action, n2, ...(await sign(action, "confirm", n2)) });
    say(out.result, out.result.startsWith("refused") || out.result.startsWith("probe failed") ? "bad" : "good");
    reset();
  } catch (e) {
    say(`Not confirmed: ${e.name}: ${e.message}. Answer again, or cancel.`, "bad");
  } finally {
    busy(false);
  }
}

async function enroll() {
  const name = $("kname").value.trim();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
    say("Name: lowercase letters, digits and dashes, up to 32.", "bad");
    return;
  }
  busy(true);
  try {
    const cred = await navigator.credentials.create({
      publicKey: {
        rp: { id: RP_ID, name: "Pi commands" },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `owner-${name}`, displayName: `Pi commands (${name})` },
        challenge: crypto.getRandomValues(new Uint8Array(32)), // nothing is checked at enrolment: pinning is by hand
        pubKeyCredParams: [{ type: "public-key", alg: -7 }], // ES256 only
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
        attestation: "none",
        timeout: 120000,
      },
    });
    const spki = cred.response.getPublicKey && cred.response.getPublicKey();
    if (!spki) throw new Error("this browser can't export the public key");
    $("line").value = `${name} webauthn ${b64url(cred.rawId)} ${b64(spki)}`;
    say("Key made. Send the line below to be pinned on the Pi.", "good");
  } catch (e) {
    say(`No key made: ${e.name}: ${e.message}`, "bad");
  } finally {
    busy(false);
  }
}

for (const b of document.querySelectorAll("#actions button")) b.addEventListener("click", () => ask(b.dataset.action));
$("yes").addEventListener("click", confirmIt);
$("no").addEventListener("click", () => { reset(); say("Cancelled. The Pi forgets it after 90 seconds."); });
$("enroll").addEventListener("click", enroll);
if (!window.PublicKeyCredential) say("This browser has no passkey support.", "bad");
