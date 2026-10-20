"""Credential-safe fallback for an environment missing the Sites workflow helper.
Reads one credential object from hidden stdin; keeps the token in memory only.
"""
import json, os, subprocess, sys, termios
from pathlib import Path
root=Path(__file__).resolve().parents[1]
def run(args,**kwargs):
    p=subprocess.run(args,cwd=root,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,**kwargs)
    if p.returncode:
        raise RuntimeError('Source synchronization command failed: '+args[0])
    return p.stdout.strip()
fd=sys.stdin.fileno(); old=termios.tcgetattr(fd); new=termios.tcgetattr(fd);new[3]&=~termios.ECHO
termios.tcsetattr(fd,termios.TCSANOW,new)
try:
    print('Ready for credential JSON on stdin (input is hidden).',flush=True)
    credential=json.loads(sys.stdin.readline())
finally:
    termios.tcsetattr(fd,termios.TCSANOW,old)
token=credential['token']; branch=credential['branch']; remote=credential['remote_url']
if not (root/'.git').exists():run(['git','init','-b',branch])
run(['git','config','user.name','Sites workspace'])
run(['git','config','user.email','sites@workspace.invalid'])
existing=run(['git','remote'])
run(['git','remote','set-url' if 'origin' in existing.split() else 'add','origin',remote])
run(['git','add','--all'])
if run(['git','status','--porcelain']):run(['git','commit','-m','Deploy Korean legal and tax reference web application'])
sha=run(['git','rev-parse','HEAD'])
# Git obtains the credential from a shell helper reading only the child environment.
# The token is never a command argument or a file, and captured stderr is not printed.
env=dict(os.environ);env['LEGAL_SITES_GIT_TOKEN']=token;env['GIT_TERMINAL_PROMPT']='0'
helper='!f() { echo username=x-access-token; echo "password=$LEGAL_SITES_GIT_TOKEN"; }; f'
if credential.get('auth_mode')=='http_extra_header':
    env.update({'GIT_CONFIG_COUNT':'1','GIT_CONFIG_KEY_0':'http.extraHeader','GIT_CONFIG_VALUE_0':'Authorization: Bearer '+token})
    run(['git','push','origin','HEAD:'+branch],env=env)
else:
    run(['git','-c','credential.helper=','-c','credential.helper='+helper,'push','origin','HEAD:'+branch],env=env)
print(json.dumps({'pushed':True,'commit_sha':sha}),flush=True)
