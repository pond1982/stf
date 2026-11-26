#!/usr/bin/env python3
"""Run Mobile Agent Testers missions on a selected local phone."""
import argparse
import base64
from contextlib import contextmanager
import datetime
import fcntl
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen

from device import Android, IPhone, ROOT

REV = "3905258f116896fbff95d40812499930d1b8c87e"
SOURCE = "https://raw.githubusercontent.com/pierridotite/mobile-agent-testers/" + REV
DATA = ROOT / "tmp/mobile-testers"
ACTIONS = "Action choices: screen, tap (x,y), swipe (x,y,to_x,to_y), type (text), finish. Coordinates are integers from 0 to 1000 across the displayed screenshot. Typing appends to the focused field."


def load(path):
    return json.loads(path.read_text())


def save(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n")
    temporary.replace(path)


def template(name):
    dest = DATA / "templates" / REV / name
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        with urlopen(SOURCE + "/" + name, timeout=25) as response:
            data = response.read()
        with tempfile.NamedTemporaryFile(dir=dest.parent, delete=False) as f:
            f.write(data)
        Path(f.name).replace(dest)
    return dest.read_text()


@contextmanager
def exclusive(serial):
    locks = DATA / "locks"
    locks.mkdir(parents=True, exist_ok=True)
    with (locks / hashlib.sha256(serial.encode()).hexdigest()).open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another device command is in progress")
        yield


def device(config):
    cls = IPhone if config["platform"] == "ios" else Android
    return cls(config["serial"], config["app"])


def check_app(phone):
    if phone.foreground() != phone.app:
        raise ValueError("The target app is not in the foreground. Return to it before continuing.")


def capture(phone, folder):
    check_app(phone)
    raw, size = phone.screenshot()
    check_app(phone)
    if min(size) <= 0:
        raise ValueError("Invalid device window size")
    index = max([int(p.stem) for p in folder.glob("[0-9]*.png") if p.stem.isdigit()] or [0]) + 1
    path = folder / f"{index:02}.png"
    with tempfile.TemporaryDirectory(dir=folder) as scratch:
        source = Path(scratch) / "original"
        source.write_bytes(raw)
        png = Path(scratch) / "screen.png"
        subprocess.run(["sips", "-s", "format", "png", "-Z", "1000", str(source), "--out", str(png)],
                       stdout=subprocess.DEVNULL, check=True, timeout=20)
        png.replace(path)
    save(folder / "frame.json", {"screen": path.name, "size": size})
    return path


def begin(args):
    if not re.fullmatch(r"[a-zA-Z0-9_][\w.]*", args.app):
        raise ValueError("Expected an application bundle ID or package name")
    personas = json.loads(template("personas.json"))
    persona = next((p for p in personas if p["id"] == args.persona and p["platform"] == args.platform), None)
    if not persona:
        raise ValueError("Choose a matching persona: " + ", ".join(p["id"] for p in personas if p["platform"] == args.platform))
    brief = template("AGENT_BRIEF.md")
    intro, rest = brief.split("## Tools (only these)", 1)
    rules = rest.split("## Rules", 1)[1].split("## Final report", 1)[0]
    mission = ("You are testing an installed app on the assigned device.\n" + ACTIONS +
               "\nUse the actual device configuration. Persona profile: " + persona["profile"] +
               "\nGoal for this run: " + (args.goal or persona["goal"]) +
               "\nThe explicit goal takes precedence over generic exploration instructions.\n" +
               "## Rules" + rules + "\nFinish with a summary, score (0-10) and issues with evidence screen numbers.")
    config = dict(platform=args.platform, serial=args.serial, app=args.app, persona=args.persona, revision=REV)
    with exclusive(args.serial):
        phone = device(config)
        phone.open()
        for _ in range(12):
            if phone.foreground() == args.app:
                break
            time.sleep(.4)
        check_app(phone)
        DATA.mkdir(exist_ok=True, parents=True)
        run = Path(tempfile.mkdtemp(prefix=datetime.datetime.now().strftime("%Y%m%d-%H%M%S-"), dir=DATA))
        folder = run / persona["id"]
        folder.mkdir()
        save(folder / "device.json", config)
        (folder / "mission.md").write_text(mission)
        capture(phone, folder)
    return folder


def finish(folder, decision):
    score, issues, summary = (decision.get(k) for k in ("score","issues","summary"))
    if type(score) is not int or not 0 <= score <= 10 or not isinstance(issues, list) or not isinstance(summary,str) or not summary.strip():
        raise ValueError("finish requires summary, integer score 0-10 and an issues list")
    for issue in issues:
        if not isinstance(issue,dict) or not all(isinstance(issue.get(k),str) and issue[k] for k in ("title","screen","severity")) or issue["severity"] not in ("blocker","major","minor","cosmetic"):
            raise ValueError("Each issue needs title, screen and severity")
        ids=issue.get("screens")
        if not isinstance(ids,list) or not ids or not all(isinstance(i,str) and re.fullmatch(r"\d{2,4}",i) and (folder/(i+".png")).is_file() for i in ids):
            raise ValueError("Each issue must cite existing numbered screens")
    report = "# Test report\n\n" + summary + f"\n\nScore: {score}/10\n"
    for i in issues:
        report += "\n- " + i["severity"] + ": " + i["title"] + " (screens " + ", ".join(i["screens"]) + ")\n"
    (folder/"report.md").write_text(report)
    save(folder/"findings.json", {"score":score, "issues":issues})
    return folder/"report.md"


def step(folder, decision):
    config = load(folder/"device.json")
    with exclusive(config["serial"]):
        if (folder/"findings.json").exists():
            raise ValueError("This run already has a final report")
        action = decision["action"]
        if action=="finish":
            return finish(folder,decision)
        if action not in ("screen","tap","swipe","type"):
            raise ValueError("Unknown action")
        phone=device(config)
        check_app(phone)
        if action in ("tap","swipe"):
            frame=load(folder/"frame.json")
            if decision.get("screen") != frame["screen"]:
                raise ValueError("Specify the latest screen filename for this gesture")
            _, size = phone.screenshot()
            if list(size) != frame["size"]:
                raise ValueError("Screen rotated. Capture a fresh screen before a gesture.")
            points=[]
            for keys in ([("x","y")] if action=="tap" else [("x","y"),("to_x","to_y")]):
                ratios=[decision[k] for k in keys]
                if not all(type(n) is int and 0<=n<=1000 for n in ratios):
                    raise ValueError("Coordinates must be integer thousandths from 0 to 1000")
                points.append(tuple(round(r*(d-1)/1000) for r,d in zip(ratios,size)))
            check_app(phone)
            phone.gesture(points)
        elif action=="type":
            value=decision["text"]
            if not isinstance(value,str) or not 0<len(value)<=500:raise ValueError("Expected 1-500 characters")
            phone.type_text(value)
        if action!="screen":
            with (folder/"actions.jsonl").open("a") as f:
                f.write(json.dumps({"before":load(folder/"frame.json")["screen"],"action":action})+"\n")
            time.sleep(.6)
        return capture(phone,folder)


def auto(folder, model, limit):
    # Ollama receives only this run's screenshot and mission, through loopback.
    mission=(folder/"mission.md").read_text()
    history=[]
    for turn in range(limit+1):
        screen=load(folder/"frame.json")["screen"]
        prompt=(mission+"\nReturn a single JSON object. "+ACTIONS+
                '\nExample: {"action":"tap","x":500,"y":750}. To finish provide action, summary, score, issues. '
                'Each issue needs title, severity, screen (description), screens (array of screenshot numbers like "01"). '
                "Current screen: "+screen+"\nEarlier decisions: "+json.dumps(history))
        if turn==limit:prompt+="\nAction budget exhausted. Return finish now, and describe any incomplete goal."
        msg={"role":"user","content":prompt,"images":[base64.b64encode((folder/screen).read_bytes()).decode()]}
        req=Request("http://127.0.0.1:11434/api/chat",headers={"Content-Type":"application/json"},
                    data=json.dumps({"model":model,"stream":False,"format":"json","messages":[msg]}).encode())
        with urlopen(req,timeout=180) as response:
            answer=json.loads(json.load(response)["message"]["content"])
        if turn==limit and answer.get("action")!="finish":raise ValueError("Model did not return a report at the action limit")
        answer["screen"]=screen
        result=step(folder,answer)
        print(result,flush=True)
        if answer["action"]=="finish":return
        history.append({k:v for k,v in answer.items() if k!="text"})


def main():
    cli=argparse.ArgumentParser(description=__doc__)
    sub=cli.add_subparsers(dest="cmd",required=True)
    start=sub.add_parser("start",help="open an app and prepare an upstream persona mission")
    start.add_argument("platform",choices=("ios","android"))
    for name in ("serial","app","persona"):start.add_argument("--"+name,required=True)
    start.add_argument("--goal")
    single=sub.add_parser("step",help="execute one JSON decision and capture evidence")
    single.add_argument("folder",type=Path)
    single.add_argument("decision",help="JSON object, or - to read from stdin")
    local=sub.add_parser("auto",help="drive a started run using a local Ollama vision model")
    local.add_argument("folder",type=Path)
    local.add_argument("--model",required=True)
    local.add_argument("--steps",type=int,default=30,choices=range(1,101),metavar="1..100")
    args=cli.parse_args()
    if args.cmd=="start":print(begin(args))
    elif args.cmd=="step":print(step(args.folder,json.load(sys.stdin) if args.decision=="-" else json.loads(args.decision)))
    else:auto(args.folder,args.model,args.steps)


if __name__=="__main__":
    try:main()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as exc:sys.exit(str(exc))
