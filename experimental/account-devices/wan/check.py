"""Run on the controlling NAS; the VM never receives SSH access to the real server."""
import ipaddress
import argparse
import shlex
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument('guest_ssh')
parser.add_argument('origin', type=ipaddress.IPv4Address)
parser.add_argument('report')
parser.add_argument('--ssh-bind', type=ipaddress.IPv4Address)
args = parser.parse_args()
target = 'root@'+str(args.origin)
bind = ['-b', str(args.ssh_bind)] if args.ssh_bind else []
guest_cmd = ['sudo','-n','nsenter','--net=/run/anywhere-wan-cn/netns','runuser','-u','lab','--',
             '/usr/local/bin/node','/srv/anywhere-lab/source/experimental/account-devices/lab/acceptance.mjs',
             args.report,'--wan']
with subprocess.Popen(['bash',args.guest_ssh,shlex.join(guest_cmd)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                      text=True,bufsize=1) as test:
    for line in test.stdout:
        print(line,end='',flush=True)
        if line.strip()=='RESTART_WAN_TEST_HOST':
            result=subprocess.run(['ssh','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
                                   '-o','ConnectTimeout=20',*bind,target,'systemctl restart anywhere-wan-host.service'],
                                  stdin=subprocess.DEVNULL,timeout=45)
            test.stdin.write('restarted\n' if result.returncode==0 else 'failed\n');test.stdin.flush()
            test.stdin.close()
    sys.exit(test.wait())
