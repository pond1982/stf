#!/usr/bin/env python3
"""Run a seeded, navigation-only Oonmoon test on the configured STF iPhone."""
import argparse
import base64
import getpass
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import random
import subprocess
import time
from urllib.parse import urlencode, unquote
from urllib.request import build_opener, HTTPCookieProcessor, Request
import xml.etree.ElementTree as ET

ORIGIN = "http://127.0.0.1:7100"
BUNDLE = "com.pondd.oonmoon.dev"
ROOT = Path(__file__).resolve().parents[1]
PREVIEWS = {"duckling", "goldilocks", "lionMouse", "redHen", "billyGoats", "elves", "gingerbread"}
SHELF = {"shelf.preview." + book for book in PREVIEWS} | {"shelf.settings"}


class Phone:
    def __init__(self, serial):
        self.serial = serial
        device_id = hashlib.sha256(serial.lower().encode()).hexdigest()[:12]
        self.container = f"stf-ios-{device_id}-runtime-1"
        self.cookies = http.cookiejar.CookieJar()
        self.http = build_opener(HTTPCookieProcessor(self.cookies))
        self.session = ""

    def login(self):
        password = os.environ.get("STF_PASSWORD") or getpass.getpass("STF admin password: ")
        body = urlencode({"username": "admin", "password": password}).encode()
        req = Request(ORIGIN + "/auth/local/", body, {"Origin": ORIGIN})
        self.http.open(req, timeout=20).close()

    def api(self, method, path, data=None):
        csrf = next((unquote(c.value) for c in self.cookies if c.name == "XSRF-TOKEN"), "")
        req = Request(ORIGIN + "/api/v1/" + path, json.dumps(data).encode() if data is not None else None,
                      {"Content-Type": "application/json", "X-XSRF-TOKEN": csrf}, method=method)
        with self.http.open(req, timeout=90) as response:
            return json.load(response)

    def wda(self, method, path, data=None):
        cmd = ["docker", "--context", "colima-stf", "exec", "-i", self.container,
               "curl", "-sS", "--max-time", "45", "-X", method, "-H", "Content-Type: application/json"]
        if data is not None:
            cmd.extend(["--data-binary", "@-"])
        cmd.append("http://127.0.0.1:18100" + self.session + path)
        response = json.loads(subprocess.check_output(cmd, input=json.dumps(data).encode() if data is not None else None))
        value = response.get("value")
        if isinstance(value, dict) and value.get("error"):
            raise RuntimeError(value.get("message", value["error"])[:350])
        return response

    def snapshot(self):
        active = self.wda("GET", "/wda/activeAppInfo")["value"]["bundleId"]
        if active != BUNDLE:
            raise RuntimeError("Oonmoon left the foreground: " + active)
        tree = ET.fromstring(self.wda("GET", "/source")["value"])
        nodes = {n.get("name"): n for n in tree.iter() if n.get("visible") == "true" and n.get("name")}
        if any(n.tag == "XCUIElementTypeAlert" and n.get("visible") == "true" for n in tree.iter()):
            raise RuntimeError("Unexpected alert")
        return nodes

    def wait_for(self, target):
        deadline = time.monotonic() + 12
        while time.monotonic() < deadline:
            nodes = self.snapshot()
            if target in nodes:
                return nodes
            time.sleep(0.2)
        raise RuntimeError("Expected control did not appear: " + target)

    def tap(self, name):
        element = self.wda("POST", "/element", {"using": "accessibility id", "value": name})["value"]
        element_id = element["element-6066-11e4-a52e-4f735466cecf"]
        self.wda("POST", "/element/" + element_id + "/click", {})


def run(phone, args, output, log):
    rng = random.Random(args.seed)
    nodes = phone.wait_for("shelf.settings")
    deck = []
    for step in range(1, args.steps + 1):
        expected_title = None
        if "shelf.settings" in nodes:
            if not deck:
                deck = sorted(SHELF.intersection(nodes))
                rng.shuffle(deck)
            action = deck.pop()
            if action == "shelf.settings":
                target = "gate.back"
            else:
                target = "library.preview.close"
                expected_title = nodes[action].get("label", "").rsplit(",", 1)[0].strip()
        elif "library.preview.close" in nodes:
            action, target = "library.preview.close", "shelf.settings"
        elif "gate.back" in nodes:
            action, target = "gate.back", "shelf.settings"
        else:
            raise RuntimeError("Unexpected screen")
        log(step=step, action=action, expected=target)
        phone.tap(action)
        nodes = phone.wait_for(target)
        if expected_title:
            title_node = nodes.get("library.preview.bookTitle")
            actual = title_node.get("label") if title_node is not None else None
            if actual != expected_title:
                raise RuntimeError(f"Wrong preview: expected {expected_title!r}, got {actual!r}")
        log(step=step, result="pass", title=expected_title)
    print(f"Passed {args.steps} navigation steps. Log: {output}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--steps", type=int, choices=range(1, 101), metavar="1..100", default=50)
    parser.add_argument("--serial", help="Configured STF iPhone UDID (defaults to the only configured iPhone)")
    parser.add_argument("--log", type=Path, default=Path("oonmoon-" + time.strftime("%Y%m%d-%H%M%S") + ".jsonl"))
    args = parser.parse_args()
    devices = json.loads((ROOT / "ios.local.json").read_text())["devices"]
    serials = [d["udid"] for d in devices]
    serial = args.serial or (serials[0] if len(serials) == 1 else None)
    if serial not in serials:
        parser.error("Select a configured iPhone with --serial")
    phone = Phone(serial)
    phone.login()
    with args.log.open("x", encoding="utf-8") as stream:
        def log(**fields):
            stream.write(json.dumps({"time": time.time(), **fields}, ensure_ascii=False) + "\n")
            stream.flush()

        log(app=BUNDLE, seed=args.seed, steps=args.steps)
        lease = phone.api("POST", "user/devices", {"serial": serial, "timeout": 900000})
        try:
            session = phone.wda("POST", "/session", {"capabilities": {"alwaysMatch": {
                "bundleId": BUNDLE, "shouldTerminateApp": False, "forceAppLaunch": False}}})
            phone.session = "/session/" + (session.get("sessionId") or session["value"]["sessionId"])
            run(phone, args, args.log, log)
        except Exception as exc:
            log(result="failure", detail=str(exc))
            if phone.session and phone.wda("GET", "/wda/activeAppInfo")["value"]["bundleId"] == BUNDLE:
                screenshot = phone.wda("GET", "/screenshot")["value"]
                args.log.with_suffix(".failure.png").write_bytes(base64.b64decode(screenshot))
            raise
        finally:
            try:
                if phone.session:
                    phone.wda("DELETE", "")
            finally:
                query = urlencode({"reservationId": lease["owner"]["reservationId"],
                                   "deviceChannel": lease["deviceChannel"]})
                phone.api("DELETE", "user/devices/" + serial + "?" + query)
                log(reservation="released")


if __name__ == "__main__":
    main()
