"""ADB and STF WebDriverAgent backends for a single, explicitly selected device."""
import base64
import json
import os
from pathlib import Path
import re
import runpy
import shlex
import shutil
import struct
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def adb():
    sdk = Path(os.getenv("ANDROID_HOME") or Path.home() / "Library/Android/sdk")
    return shutil.which("adb") or str(sdk / "platform-tools/adb")


class Android:
    def __init__(self, serial, app):
        self.serial = serial
        self.app = app

    def command(self, *args, binary=False):
        value = subprocess.check_output([adb(), "-s", self.serial, *args], timeout=25)
        return value if binary else value.decode().strip()

    def open(self):
        activity = self.command("shell", "cmd", "package", "resolve-activity", "--brief",
                                "-a", "android.intent.action.MAIN", "-c",
                                "android.intent.category.LAUNCHER", self.app).splitlines()[-1]
        if not activity.startswith(self.app + "/"):
            raise ValueError("App has no launchable activity on this device")
        self.command("shell", "am", "start", "-W", "-n", shlex.quote(activity))

    def foreground(self):
        state = self.command("shell", "dumpsys", "activity", "activities")
        match = re.search(r"(?:topResumedActivity|mResumedActivity).*? u\d+ ([\w.]+)/", state)
        return match.group(1) if match else ""

    def screenshot(self):
        data = self.command("exec-out", "screencap", "-p", binary=True)
        if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) < 24:
            raise ValueError("Device returned an invalid screenshot")
        return data, struct.unpack(">II", data[16:24])

    def gesture(self, points):
        flat = [str(n) for p in points for n in p]
        if len(points) == 1:
            self.command("shell", "input", "tap", *flat)
        else:
            self.command("shell", "input", "swipe", *flat, "400")

    def type_text(self, text):
        if not text.isascii() or not text.isprintable() or "%s" in text:
            raise ValueError("ADB typing accepts printable ASCII without literal %s")
        self.command("shell", "input", "text", shlex.quote(text.replace(" ", "%s")))


class IPhone:
    def __init__(self, serial, app):
        configured = json.loads((ROOT / "ios.local.json").read_text())["devices"]
        if serial not in {d["udid"] for d in configured}:
            raise ValueError("Select an iPhone configured in STF ios.local.json")
        self.app = app
        phone = runpy.run_path(str(ROOT / "tools/oonmoon-navigation.py"))["Phone"](serial)
        status = phone.wda("GET", "/status")
        if not status.get("sessionId") or not status["value"].get("ready"):
            raise ValueError("STF WebDriverAgent has no active, ready session")
        phone.session = "/session/" + status["sessionId"]
        self.phone = phone

    def request(self, method, path, body=None):
        return self.phone.wda(method, path, body)["value"]

    def open(self):
        self.request("POST", "/wda/apps/activate", {"bundleId": self.app})

    def foreground(self):
        return self.request("GET", "/wda/activeAppInfo")["bundleId"]

    def screenshot(self):
        size = self.request("GET", "/window/size")
        return base64.b64decode(self.request("GET", "/screenshot"), validate=True), (size["width"], size["height"])

    def gesture(self, points):
        x,y = points[0]
        if len(points) == 1:
            self.request("POST", "/wda/tap", {"x": x, "y": y})
        else:
            tx,ty = points[1]
            self.request("POST", "/wda/dragfromtoforduration",
                         {"fromX": x, "fromY": y, "toX": tx, "toY": ty, "duration": .4})

    def type_text(self, text):
        self.request("POST", "/wda/keys", {"value": [text]})
