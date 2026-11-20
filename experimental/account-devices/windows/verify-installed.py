"""Launch Windows native UI Automation in the signed-in user's desktop and retrieve its report."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

p=argparse.ArgumentParser()
p.add_argument("windows")
p.add_argument("identity")
p.add_argument("accounts",type=Path)
p.add_argument("reports",type=Path)
p.add_argument("--fresh",action="store_true",help="Launch the installed build with an empty app-data directory")
p.add_argument("--project-access",action="store_true",help="Verify project grants in an empty profile without repeating the invalid-password test")
args=p.parse_args()
if args.project_access: args.fresh=True
run=str(uuid.uuid4())
opts=["-o","BatchMode=yes","-o","IdentitiesOnly=yes","-o","StrictHostKeyChecking=yes","-o","ConnectTimeout=10","-i",args.identity]
args.reports.mkdir(parents=True,exist_ok=True)
stage="AppData/Local/AnywhereCodingLab/staging"
with tempfile.TemporaryDirectory() as staging:
    inputfile=Path(staging) / ("installed-ui-"+run+".ps1")
    inputfile.write_text(Path(__file__).with_name("installed-ui.ps1").read_text(),encoding="utf-8-sig")
    subprocess.run(["scp","-q",*opts,str(inputfile),args.windows+":"+stage+"/"+inputfile.name],check=True)
member=next(a for a in json.loads(args.accounts.read_text()) if a["username"]==("lab-other" if args.fresh else "lab-coder"))
print("Windows interactive verification",run,flush=True)
result=subprocess.run(["ssh","-T",*opts,args.windows,"powershell.exe -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -File "+stage+"/"+inputfile.name],
                      input=json.dumps({"runId":run,"fresh":args.fresh,"projectAccess":args.project_access,"username":member["username"],"password":member["password"]}).encode(),
                      stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=940)
def collect(name):
    target=args.reports/name
    r=subprocess.run(["scp","-q",*opts,args.windows+":AppData/Local/AnywhereCodingLab/artifacts/"+name,str(target)],capture_output=True)
    return target if r.returncode==0 else None
name="installed-"+run
report=collect(name+".json")
if not report:
    sys.exit("No Windows report: "+result.stderr.decode(errors="replace")[-600:])
state=json.loads(report.read_text(encoding="utf-8-sig"))
for suffix in ("signin","home","consent","file","followup","full-permission","command","diagnostic"):
    collect(name+"-"+suffix+".png")
print(json.dumps({k:state.get(k) for k in ("phase","passed","checks","error","line")},ensure_ascii=False),flush=True)
sys.exit(0 if result.returncode==0 and state.get("passed") else 1)
