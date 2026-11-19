"""Run on the controlling NAS; the VM never receives SSH access to the real server."""
import ipaddress
import shlex
import subprocess
import sys

guest_ssh, ip, report = sys.argv[1:]
target = 'root@'+str(ipaddress.IPv4Address(ip))
guest_cmd = ['sudo','-n','nsenter','--net=/run/anywhere-wan-cn/netns','runuser','-u','lab','--',
             '/usr/local/bin/node','/srv/anywhere-lab/source/experimental/account-devices/lab/acceptance.mjs',
             report,'--wan']
with subprocess.Popen(['bash',guest_ssh,shlex.join(guest_cmd)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                      text=True,bufsize=1) as test:
    for line in test.stdout:
        print(line,end='',flush=True)
        if line.strip()=='RESTART_WAN_TEST_HOST':
            result=subprocess.run(['ssh','-T','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
                                   '-o','ConnectTimeout=8',target,'systemctl restart anywhere-wan-host.service'],
                                  stdin=subprocess.DEVNULL,timeout=35)
            test.stdin.write('restarted\n' if result.returncode==0 else 'failed\n');test.stdin.flush()
            test.stdin.close()
    sys.exit(test.wait())
