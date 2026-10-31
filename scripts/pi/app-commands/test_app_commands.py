"""Design section 4.1: every refusal, and the happy path, over real HTTP. Nothing fires: the actuators are `true`.

Run: python3 -I scripts/pi/app-commands/test_app_commands.py
"""
import base64
import importlib.machinery
import importlib.util
import json
import os
import secrets
import socket
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec

HERE = os.path.dirname(os.path.abspath(__file__))
_loader = importlib.machinery.SourceFileLoader("acr", os.path.join(HERE, "app-commands-receiver"))
_spec = importlib.util.spec_from_loader("acr", _loader)
acr = importlib.util.module_from_spec(_spec)
_loader.exec_module(acr)


def spki(key):
    return base64.b64encode(key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)).decode()


def sign(key, box, action, step, nonce):
    return base64.b64encode(key.sign(acr.signed_bytes(box, action, step, nonce), ec.ECDSA(hashes.SHA256()))).decode()


class Rig:
    def __init__(self, dry_run=True, ks_dry=True, ks_state=None):
        self.dir = tempfile.mkdtemp()
        self.phone = ec.generate_private_key(ec.SECP256R1())
        self.spare = ec.generate_private_key(ec.SECP256R1())
        self.stranger = ec.generate_private_key(ec.SECP256R1())
        self.keys = os.path.join(self.dir, "keys")
        with open(self.keys, "w") as f:
            f.write(f"# test keys\nphone p256 - {spki(self.phone)}\nspare p256 - {spki(self.spare)}\n"
                    f"yubikey webauthn Y3JlZA {spki(self.spare)}\n")
        ksc = os.path.join(self.dir, "ks.json")
        with open(ksc, "w") as f:
            json.dump({"dry_run": ks_dry, "lock_command": ["true"]}, f)
        self.ks_state = os.path.join(self.dir, "ks-state.json")
        if ks_state:
            with open(self.ks_state, "w") as f:
                json.dump({"state": ks_state}, f)
        cfg = dict(acr.DEFAULTS, box="pi", dry_run=dry_run, keys_file=self.keys, keys_must_be_root=False,
                   state_dir=self.dir, log_file=None, killswitch_config=ksc, killswitch_state=self.ks_state,
                   defib_command=["true"],
                   probe_command=["sh", "-c", 'echo "$0" > "$1"', "ok", os.path.join(self.dir, "probe.txt")],
                   probe_result=os.path.join(self.dir, "probe.txt"))
        self.rx = acr.Receiver(cfg)
        self.servers = [acr.FreebindServer(("127.0.0.1", 0), acr.make_handler(self.rx)) for _ in range(2)]
        for s in self.servers:
            threading.Thread(target=s.serve_forever, daemon=True).start()

    def close(self):
        for s in self.servers:
            s.shutdown()
            s.server_close()

    def post(self, path, body, server=0):
        port = self.servers[server].server_address[1]
        data = json.dumps(body).encode() if not isinstance(body, bytes) else body
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=data,
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=10) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def request(self, action, key=None, name="phone", box="pi", n1=None):
        n1 = n1 or secrets.token_hex(32)
        key = key or self.phone
        return self.post("/request", {"action": action, "n1": n1, "key": name,
                                      "sig": sign(key, box, action, "request", n1)}), n1

    def confirm(self, action, n2, key=None, name="phone", box="pi", server=0):
        key = key or self.phone
        return self.post("/confirm", {"action": action, "n2": n2, "key": name,
                                      "sig": sign(key, box, action, "confirm", n2)}, server)

    def two_step(self, action, **kw):
        (code, out), _ = self.request(action, **kw)
        assert code == 200, out
        return self.confirm(action, out["n2"], **kw)


class Section41(unittest.TestCase):
    def setUp(self):
        self.r = Rig()

    def tearDown(self):
        self.r.close()

    def refused(self, resp, code=200):
        got, out = resp
        self.assertEqual(got, code, out)
        self.assertTrue(out["result"].startswith("refused: "), out)
        return out["result"]

    def test_happy_path_is_a_dry_run(self):
        self.assertEqual(self.r.two_step("defib-fire"), (200, {"result": "dry run: would fire"}))
        self.assertEqual(self.r.rx.state["last_fire"], 0)  # a dry run starts no cooldown

    def test_wrong_key(self):
        self.refused(self.r.request("defib-fire", key=self.r.stranger)[0])
        self.assertIsNone(self.r.rx.pending)

    def test_unknown_key_name(self):
        self.assertIn("unknown key", self.refused(self.r.request("defib-fire", name="stranger")[0]))

    def test_unsigned_request(self):
        n1 = secrets.token_hex(32)
        self.refused(self.r.post("/request", {"action": "defib-fire", "n1": n1, "key": "phone"}))
        self.refused(self.r.post("/request", {"action": "defib-fire", "n1": n1, "key": "phone", "sig": ""}))
        self.refused(self.r.post("/request", b"not json"), code=400)
        self.assertIsNone(self.r.rx.pending)

    def test_replayed_n1(self):
        (code, _), n1 = self.r.request("kill-arm")
        self.assertEqual(code, 200)
        self.assertIn("replayed", self.refused(self.r.request("kill-arm", n1=n1)[0]))

    def test_replayed_n1_after_restart(self):
        (code, _), n1 = self.r.request("kill-arm")
        self.assertEqual(code, 200)
        self.r.rx.__init__(self.r.rx.cfg)  # reload state from disk, as a restart would
        self.assertIn("replayed", self.refused(self.r.request("kill-arm", n1=n1)[0]))

    def test_replayed_n2(self):
        (code, out), _ = self.r.request("defib-fire")
        self.assertEqual(self.r.confirm("defib-fire", out["n2"])[0], 200)
        self.assertIn("no pending", self.refused(self.r.confirm("defib-fire", out["n2"])))

    def test_confirm_after_90_s(self):
        (code, out), _ = self.r.request("defib-fire")
        self.r.rx.pending["deadline"] = time.monotonic() - 0.001
        self.assertIn("too late", self.refused(self.r.confirm("defib-fire", out["n2"])))
        self.assertIsNone(self.r.rx.pending)

    def test_action_changed_between_steps(self):
        (code, out), _ = self.r.request("kill-arm")
        self.assertIn("action changed", self.refused(self.r.confirm("defib-fire", out["n2"])))
        self.assertIsNotNone(self.r.rx.pending)  # a bad confirm leaves the pending entry

    def test_nonce_signed_for_another_box(self):
        self.refused(self.r.request("defib-fire", box="newpc")[0])
        (code, out), _ = self.r.request("defib-fire")
        self.assertIn("bad signature", self.refused(self.r.confirm("defib-fire", out["n2"], box="truenas")))
        self.assertIsNotNone(self.r.rx.pending)

    def test_signed_as_request_used_as_confirm(self):
        (code, out), _ = self.r.request("defib-fire")
        n2 = out["n2"]
        sig = sign(self.r.phone, "pi", "defib-fire", "request", n2)
        self.refused(self.r.post("/confirm", {"action": "defib-fire", "n2": n2, "key": "phone", "sig": sig}))

    def test_confirm_with_no_request(self):
        self.assertIn("no pending", self.refused(self.r.confirm("defib-fire", secrets.token_hex(32))))

    def test_confirm_with_wrong_n2(self):
        self.r.request("defib-fire")
        self.assertIn("does not match", self.refused(self.r.confirm("defib-fire", secrets.token_hex(32))))
        self.assertIsNotNone(self.r.rx.pending)

    def test_confirm_by_another_pinned_key(self):
        (code, out), _ = self.r.request("defib-fire")
        self.assertIn("another key", self.refused(
            self.r.confirm("defib-fire", out["n2"], key=self.r.spare, name="spare")))

    def test_webauthn_key_refused_for_now(self):
        self.assertIn("webauthn", self.refused(self.r.request("defib-fire", key=self.r.spare, name="yubikey")[0]))

    def test_uppercase_nonce_refused(self):
        n1 = secrets.token_hex(32).upper()
        self.refused(self.r.request("defib-fire", n1=n1)[0])

    def test_two_concurrent_confirms_exactly_one_passes(self):
        for _ in range(20):
            (code, out), _ = self.r.request("defib-fire")
            results = []
            barrier = threading.Barrier(2)

            def go(server):
                barrier.wait()
                results.append(self.r.confirm("defib-fire", out["n2"], server=server)[1]["result"])

            ts = [threading.Thread(target=go, args=(i,)) for i in (0, 1)]
            for t in ts:
                t.start()
            for t in ts:
                t.join()
            self.assertEqual(sorted(results), ["dry run: would fire", "refused: no pending request"])

    def test_refusals_reach_the_alert_queue(self):
        self.r.request("defib-fire", key=self.r.stranger)
        with open(self.r.rx.alerts_path) as f:
            self.assertIn("LOUD refused request from 127.0.0.1: bad signature", f.read())

    def test_probe_stops_before_acting(self):
        self.assertEqual(self.r.two_step("probe"), (200, {"result": "probe ok"}))
        self.assertEqual(self.r.rx.state["last_fire"], 0)

    def test_probe_reports_what_the_root_check_found(self):
        self.r.rx.cfg["probe_command"][3] = "lock: polkit refuses"
        self.assertEqual(self.r.two_step("probe")[1]["result"], "probe failed: lock: polkit refuses")

    def test_probe_unit_that_fails_to_start(self):
        self.r.rx.cfg["probe_command"] = ["false"]
        self.assertIn("probe unit didn't run", self.r.two_step("probe")[1]["result"])

    def test_probe_never_reads_a_stale_ok(self):
        with open(self.r.rx.cfg["probe_result"], "w") as f:
            f.write("ok\n")
        os.utime(self.r.rx.cfg["probe_result"], (time.time() - 60, time.time() - 60))
        self.r.rx.cfg["probe_command"] = ["true"]  # runs, writes nothing
        self.assertIn("no fresh result", self.r.two_step("probe")[1]["result"])

    def test_slow_client_does_not_block_a_confirm(self):
        (code, out), _ = self.r.request("defib-fire")
        port = self.r.servers[0].server_address[1]
        slow = socket.create_connection(("127.0.0.1", port))
        slow.sendall(b"POST /confirm HTTP/1.1\r\nHost: x\r\n")  # and then nothing
        t0 = time.monotonic()
        self.assertEqual(self.r.confirm("defib-fire", out["n2"]), (200, {"result": "dry run: would fire"}))
        self.assertLess(time.monotonic() - t0, 2)
        slow.close()

    def test_wrong_shape_state_starts_locked_safe(self):
        with open(self.r.rx.state_path, "w") as f:
            json.dump({"seen_n1": None}, f)
        self.r.rx.__init__(self.r.rx.cfg)
        self.assertEqual(self.r.rx.state["kill_state"], "LOCKED")
        self.assertTrue(self.r.rx.cooling())

    def test_junk_key_name_is_not_echoed(self):
        self.assertEqual(self.refused(self.r.request("defib-fire", name="<b>x\n")[0]), "refused: unknown key")

    def test_kill_on_dry_by_killswitch_config(self):
        self.assertEqual(self.r.two_step("kill-on"), (200, {"result": "dry run: would lock pi"}))
        self.assertEqual(self.r.rx.state["kill_state"], "DISARMED")

    def test_keys_file_must_be_root_owned(self):
        self.r.rx.cfg["keys_must_be_root"] = True
        if os.getuid() != 0:
            self.assertIn("root-owned", self.refused(self.r.request("defib-fire")[0]))


class LiveConfigWithHarmlessActuators(unittest.TestCase):
    def tearDown(self):
        self.r.close()

    def test_defib_cooldown(self):
        self.r = Rig(dry_run=False)
        self.assertEqual(self.r.two_step("defib-fire"), (200, {"result": "fired"}))
        (code, out), _ = self.r.request("defib-fire")
        self.assertEqual((code, out), (200, {"result": "refused: defib cooling down (10 min after a fire)"}))
        self.r.rx.__init__(self.r.rx.cfg)  # a restart keeps the cooldown
        self.assertIn("cooling", self.r.request("defib-fire")[0][1]["result"])

    def test_failed_defib_start_leaves_no_cooldown(self):
        self.r = Rig(dry_run=False)
        self.r.rx.cfg["defib_command"] = ["false"]
        self.assertIn("actuator failed", self.r.two_step("defib-fire")[1]["result"])
        self.assertFalse(self.r.rx.cooling())

    def test_kill_states(self):
        self.r = Rig(dry_run=False, ks_dry=False)
        self.assertEqual(self.r.two_step("kill-arm")[1]["result"], "pi: ARMED")
        self.assertEqual(self.r.two_step("kill-off")[1]["result"], "pi: DISARMED")
        self.assertEqual(self.r.two_step("kill-on")[1]["result"], "pi: locking now; recovery is console-only")
        self.assertIn("LOCKED; arm ignored", self.r.two_step("kill-arm")[1]["result"])
        self.assertIn("no remote unlock", self.r.two_step("kill-off")[1]["result"])
        self.assertEqual(self.r.rx.state["kill_state"], "LOCKED")

    def test_locked_in_telegram_receiver_counts(self):
        self.r = Rig(dry_run=False, ks_dry=False, ks_state="LOCKED")
        self.assertIn("no remote unlock", self.r.two_step("kill-off")[1]["result"])
        self.assertEqual(self.r.rx.state["kill_state"], "DISARMED")


if __name__ == "__main__":
    unittest.main()
